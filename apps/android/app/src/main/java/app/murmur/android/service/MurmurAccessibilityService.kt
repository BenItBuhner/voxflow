package app.murmur.android.service

import android.accessibilityservice.AccessibilityService
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import android.net.Uri
import android.graphics.PixelFormat
import android.graphics.Rect
import android.os.Build
import android.os.SystemClock
import android.util.DisplayMetrics
import android.util.Log
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo
import app.murmur.android.MainActivity
import app.murmur.android.dictation.DictationController
import app.murmur.android.dictation.DictationState
import app.murmur.android.dictation.TextSink
import app.murmur.android.overlay.Box
import app.murmur.android.overlay.OverlayEditor
import app.murmur.android.overlay.OverlayLayout
import app.murmur.android.overlay.OverlayPillView
import app.murmur.android.overlay.PillTheme
import app.murmur.android.settings.SettingsStore
import app.murmur.android.ui.Route
import app.murmur.android.update.UpdateManager
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlin.math.max
import kotlin.math.roundToInt

private const val TAG = "MurmurA11y"

/**
 * How long to keep looking for the focused field before giving up. Chromium hands the framework no
 * node provider for a page until the renderer has delivered the accessibility tree, which it only
 * builds once something asks for it, so the first lookup into a PWA or browser tab that just came to
 * the front can come back empty while a field is plainly focused; One UI likewise reports no active
 * window for a moment after an overlay was touched. A few short retries cover both.
 */
private const val TARGET_LOOKUP_ATTEMPTS = 5
private const val TARGET_LOOKUP_RETRY_MS = 90L

/**
 * Inserting text fires a burst of focus/selection events, and re-scanning the window list (an IPC
 * round trip) for each of them stalls the main thread exactly while the pill is morphing to
 * "Inserted". Those events only trigger a scan when the last one is older than this; window
 * events (the keyboard actually appearing or leaving) always scan.
 */
private const val WINDOW_SCAN_MIN_INTERVAL_MS = 120L
/** How much of the field before the cursor the formatting model is shown. */
private const val PRECEDING_TEXT_MAX = 600

/**
 * The Wispr Flow pattern on Android: whenever the keyboard comes up, a floating dictation
 * button appears next to it (by default centred just above it; the user can park it anywhere,
 * including on the keyboard's own toolbar). Tap to dictate, tap again to stop; the transcribed,
 * cleaned text is inserted into the focused text field via accessibility actions.
 *
 * The pill view owns its geometry and animations and asks this service (its [OverlayPillView.Host])
 * for two windows: a canvas it draws in, which is never touchable and never moves while the mic
 * turns on or off, and an invisible touch window that hugs the pill and relays taps to it.
 *
 * This service is also the injection backend ([TextSink]); see [TextInserter] for the
 * ACTION_SET_TEXT / ACTION_SET_SELECTION / ACTION_PASTE strategy.
 */
class MurmurAccessibilityService : AccessibilityService(), TextSink, OverlayPillView.Host {

    private var windowManager: WindowManager? = null
    private var pill: OverlayPillView? = null

    /** Draws the pill. Never touchable, and only ever grows, so state changes never move it. */
    private var canvasWindow: OverlayWindow? = null

    /** Invisible; hugs the pill and relays its touches. Free to follow the pill, nothing is drawn in it. */
    private var touchWindow: OverlayWindow? = null
    private var keyboardVisible = false

    /** Top edge of the keyboard the last time it was on screen; kept while a dictation is in flight. */
    private var keyboardTop = -1
    private var lastWindowScanAt = 0L
    private var lastEditable: AccessibilityNodeInfo? = null
    private var lastPackage: String = ""
    private val mainScope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

    override fun onServiceConnected() {
        super.onServiceConnected()
        instance = this
        DictationController.sink = this
        windowManager = getSystemService(WINDOW_SERVICE) as WindowManager
        val settings = SettingsStore.get(this)
        mainScope.launch {
            DictationController.state.collect { state ->
                pill?.render(state)
                // Keep the pill on screen while a dictation is in flight even if the
                // keyboard gets dismissed underneath it.
                if (state !is DictationState.Idle) showPill() else syncPillVisibility()
            }
        }
        mainScope.launch {
            settings.flow.collect { s ->
                pill?.setPalette(PillTheme.resolve(this@MurmurAccessibilityService, s))
                pill?.configure(s.overlayShape, s.overlayLayout)
            }
        }
        mainScope.launch {
            OverlayEditor.editing.collect { editing ->
                if (editing) showPill()
                pill?.setEditing(editing)
                syncPillVisibility()
            }
        }
        // The only long-lived part of the app: the daily update check lives here. An unattended
        // install waits until no dictation is in flight and the keyboard is away.
        UpdateManager.get(this).apply {
            isIdle = { DictationController.state.value is DictationState.Idle && !keyboardVisible }
            startBackgroundChecks(mainScope)
        }
        Log.i(TAG, "accessibility service connected")
    }

    override fun onDestroy() {
        if (instance === this) instance = null
        if (DictationController.sink === this) DictationController.sink = null
        OverlayEditor.stop()
        removePill()
        mainScope.cancel()
        super.onDestroy()
    }

    override fun onInterrupt() = Unit

    /** A new wallpaper (or dark mode flip) arrives as a configuration change; re-read the theme colours. */
    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        pill?.setPalette(PillTheme.resolve(this, SettingsStore.get(this).get()))
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent) {
        when (event.eventType) {
            AccessibilityEvent.TYPE_VIEW_FOCUSED,
            AccessibilityEvent.TYPE_VIEW_TEXT_SELECTION_CHANGED -> {
                val source = event.source ?: return
                if (source.acceptsText()) {
                    lastEditable = source
                    lastPackage = event.packageName?.toString() ?: lastPackage
                }
                updateKeyboardState(force = false)
            }
            AccessibilityEvent.TYPE_WINDOWS_CHANGED,
            AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED -> updateKeyboardState(force = true)
        }
    }

    // ---- keyboard tracking ----------------------------------------------------------------

    private fun updateKeyboardState(force: Boolean) {
        val now = SystemClock.uptimeMillis()
        if (!force && now - lastWindowScanAt < WINDOW_SCAN_MIN_INTERVAL_MS) return
        lastWindowScanAt = now
        var visible = false
        var top = -1
        try {
            for (w in windows) {
                if (w.type == AccessibilityWindowInfo.TYPE_INPUT_METHOD) {
                    val bounds = Rect()
                    w.getBoundsInScreen(bounds)
                    // Some keyboards keep a zero-height window alive while hidden.
                    if (bounds.height() > 80) {
                        visible = true
                        top = bounds.top
                    }
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "window scan failed", e)
        }
        keyboardVisible = visible
        if (visible) keyboardTop = top
        syncPillVisibility()
    }

    private fun syncPillVisibility() {
        val busy = DictationController.state.value !is DictationState.Idle
        if (keyboardVisible || busy || OverlayEditor.editing.value) showPill() else removePill()
    }

    /** Where the pill measures its vertical offset from: the keyboard's top edge, or the last known one while busy. */
    private fun keyboardReference(): Int? {
        if (keyboardVisible) return keyboardTop
        val busy = DictationController.state.value !is DictationState.Idle || OverlayEditor.editing.value
        return if (busy && keyboardTop > 0) keyboardTop else null
    }

    private fun showPill() {
        val wm = windowManager ?: return
        val (screenW, screenH) = screenSize()
        val existing = pill
        if (existing != null) {
            existing.setScreen(screenW, screenH, keyboardReference())
            return
        }
        val settings = SettingsStore.get(this)
        val view = OverlayPillView(this).apply {
            host = this@MurmurAccessibilityService
            onMicTap = { DictationController.toggle(this@MurmurAccessibilityService) }
            onCancelTap = { DictationController.cancel(this@MurmurAccessibilityService) }
            onConfirmTap = { DictationController.stopAndInsert(this@MurmurAccessibilityService) }
            // The field the dictation was meant for is still focused: send the audio again into it.
            onRetryTap = { id -> DictationController.retry(this@MurmurAccessibilityService, id, insert = true) }
            onDismissTap = { DictationController.dismiss() }
            // The limit notice's ways forward: the web account page, or the Speech model screen.
            onUpgradeTap = { url -> openUrl(url); DictationController.dismiss() }
            onOwnModelTap = { openApp(Route.MODEL); DictationController.dismiss() }
            onLayoutChanged = { layout -> settings.update { it.copy(overlayLayout = layout) } }
            onEditDone = { OverlayEditor.stop() }
            onEditReset = { settings.update { it.copy(overlayLayout = OverlayLayout.DEFAULT) } }
        }
        // Raw coordinates are display coordinates, which is the pill's own frame of reference, so
        // the relay does not depend on where the touch window happens to be at that instant.
        val relay = TouchRelayView(this) { ev -> view.onScreenTouch(ev, ev.rawX, ev.rawY) }
        pill = view
        canvasWindow = OverlayWindow(wm, view, touchable = false)
        touchWindow = OverlayWindow(wm, relay, touchable = true)
        val s = settings.get()
        view.setPalette(PillTheme.resolve(this, s))
        view.configure(s.overlayShape, s.overlayLayout)
        view.setEditing(OverlayEditor.editing.value)
        // Computes the first frames and, through the Host callbacks, adds both windows.
        view.setScreen(screenW, screenH, keyboardReference())
        view.render(DictationController.state.value)
        if (canvasWindow?.attached != true || touchWindow?.attached != true) removePill()
    }

    override fun applyCanvasFrame(frame: Box) {
        canvasWindow?.place(frame)
    }

    override fun applyTouchFrame(frame: Box) {
        touchWindow?.place(frame)
    }

    private fun removePill() {
        touchWindow?.remove()
        canvasWindow?.remove()
        touchWindow = null
        canvasWindow = null
        pill = null
    }

    private fun screenSize(): Pair<Int, Int> {
        val wm = windowManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && wm != null) {
            val bounds = wm.currentWindowMetrics.bounds
            return bounds.width() to bounds.height()
        }
        val metrics = DisplayMetrics()
        @Suppress("DEPRECATION")
        wm?.defaultDisplay?.getRealMetrics(metrics)
        if (metrics.widthPixels <= 0 || metrics.heightPixels <= 0) {
            val dm = resources.displayMetrics
            return dm.widthPixels to dm.heightPixels
        }
        return metrics.widthPixels to metrics.heightPixels
    }

    // ---- TextSink ---------------------------------------------------------------------------

    override fun focusedPackage(): String {
        val root = rootInActiveWindow
        return root?.packageName?.toString() ?: lastPackage
    }

    /**
     * What is already in the field before the cursor, so the model can continue it (no capital
     * mid-sentence, an ongoing list keeps its markers, the same language). Read on the main thread
     * like every other node interrogation; null when there is no field or the field hides its text.
     */
    override suspend fun precedingText(): String? = withContext(Dispatchers.Main.immediate) {
        val node = runCatching { findEditableTarget() }.getOrNull() ?: return@withContext null
        if (node.isPassword || node.isShowingHintText) return@withContext null
        val text = node.text?.toString()?.takeIf { it.isNotEmpty() } ?: return@withContext null
        val caret = node.textSelectionStart.takeIf { it in 0..text.length } ?: text.length
        text.substring(0, caret).takeIf { it.isNotBlank() }?.takeLast(PRECEDING_TEXT_MAX)
    }

    /**
     * Accessibility node calls are plain binder IPC and work from any thread, but the framework
     * caches node state per thread and same-process interrogation (our own test pad) is only
     * short-circuited on the main thread, so the whole insertion runs there.
     */
    override suspend fun insert(text: String, pressEnter: Boolean): String? =
        withContext(Dispatchers.Main.immediate) {
            val node = awaitEditableTarget()
            if (node == null) {
                Log.w(TAG, "no focused editable field; copied to clipboard")
                copyToClipboard(text)
                return@withContext COPIED_NO_FIELD
            }
            val target = NodeTarget(node)
            when (val outcome = TextInserter.insert(target, text, pressEnter, ::copyToClipboard)) {
                is InsertOutcome.Inserted -> {
                    Log.i(
                        TAG,
                        "inserted ${text.length} chars via ${outcome.method} into ${node.packageName}" +
                            if (target.isWebContent) " (web content)" else ""
                    )
                    null
                }
                is InsertOutcome.Failed -> {
                    Log.w(TAG, "insertion failed: ${outcome.message}")
                    outcome.message
                }
            }
        }

    private suspend fun awaitEditableTarget(): AccessibilityNodeInfo? =
        retryLookup(TARGET_LOOKUP_ATTEMPTS, TARGET_LOOKUP_RETRY_MS) { attempt ->
            findEditableTarget().also {
                if (it == null && attempt < TARGET_LOOKUP_ATTEMPTS - 1) {
                    Log.d(TAG, "no focused field yet (attempt ${attempt + 1}); retrying")
                }
            }
        }

    /**
     * The field the dictation belongs in. The input-focused node of the active window is the
     * normal answer; when the system has no active window for a moment (One UI does this right
     * after an overlay was touched) every application window is checked, and the field that most
     * recently reported focus is the last resort, provided it belongs to the app in front: a
     * remembered field from an app that is still alive in the background must not swallow a
     * dictation meant for the one the user is looking at.
     */
    private fun findEditableTarget(): AccessibilityNodeInfo? {
        focusedEditable(rootInActiveWindow)?.let { return it }
        val visible = try {
            windows
        } catch (e: Exception) {
            Log.w(TAG, "window scan failed", e)
            emptyList()
        }
        // Windows come top-most first; the focused application window, or failing that the one on
        // top, is the app the user is looking at. (The active window itself may be the keyboard.)
        var frontPackage: String? = null
        for (w in visible.sortedByDescending { it.isFocused }) {
            if (w.type != AccessibilityWindowInfo.TYPE_APPLICATION) continue
            val root = runCatching { w.root }.getOrNull() ?: continue
            if (frontPackage == null) frontPackage = root.packageName?.toString()
            focusedEditable(root)?.let { return it }
        }
        val remembered = lastEditable ?: return null
        if (!runCatching { remembered.refresh() }.getOrDefault(false) || !remembered.acceptsText()) return null
        val rememberedPackage = remembered.packageName?.toString()
        if (frontPackage != null && rememberedPackage != frontPackage) {
            Log.d(TAG, "ignoring remembered field of $rememberedPackage; $frontPackage is in front")
            return null
        }
        return remembered
    }

    private fun focusedEditable(root: AccessibilityNodeInfo?): AccessibilityNodeInfo? {
        val focus = runCatching { root?.findFocus(AccessibilityNodeInfo.FOCUS_INPUT) }.getOrNull() ?: return null
        return if (focus.acceptsText()) focus else null
    }

    private fun copyToClipboard(text: String) {
        val cm = getSystemService(CLIPBOARD_SERVICE) as ClipboardManager
        cm.setPrimaryClip(ClipData.newPlainText("Murmur dictation", text))
    }

    /** The web account page, in the browser. Only https links, and only from the pill's own state. */
    private fun openUrl(url: String) {
        if (!url.startsWith("https://")) return
        try {
            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (e: Exception) {
            Log.w(TAG, "could not open $url", e)
        }
    }

    /** Bring Murmur to the front on [route]. */
    private fun openApp(route: Route) {
        try {
            startActivity(MainActivity.intentFor(this, route).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (e: Exception) {
            Log.w(TAG, "could not open Murmur", e)
        }
    }

    companion object {
        @Volatile
        var instance: MurmurAccessibilityService? = null
            private set

        val isRunning: Boolean get() = instance != null
    }
}

/**
 * One accessibility-overlay window placed in screen coordinates. A non-touchable window is skipped
 * by input dispatch entirely, so the pill's canvas can be as large as it likes without stealing
 * taps from the keyboard underneath it.
 */
private class OverlayWindow(private val wm: WindowManager, private val view: View, touchable: Boolean) {
    private val params = WindowManager.LayoutParams(
        1,
        1,
        WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
        WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
            WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or
            WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN or
            (if (touchable) 0 else WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE),
        PixelFormat.TRANSLUCENT
    ).apply {
        gravity = Gravity.TOP or Gravity.START
        x = 0
        y = 0
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
        }
    }

    var attached = false
        private set

    fun place(frame: Box) {
        params.x = frame.left.roundToInt()
        params.y = frame.top.roundToInt()
        params.width = max(1, frame.width.roundToInt())
        params.height = max(1, frame.height.roundToInt())
        try {
            if (!attached) {
                wm.addView(view, params)
                attached = true
            } else {
                wm.updateViewLayout(view, params)
            }
        } catch (e: Exception) {
            Log.e(TAG, "failed to place overlay window", e)
        }
    }

    fun remove() {
        if (!attached) return
        attached = false
        try {
            wm.removeView(view)
        } catch (_: Exception) {
        }
    }
}

/** Draws nothing; hands every touch to the pill, which does its own hit-testing in screen space. */
private class TouchRelayView(context: Context, private val relay: (MotionEvent) -> Boolean) : View(context) {
    override fun onTouchEvent(event: MotionEvent): Boolean = relay(event)

    override fun performClick(): Boolean {
        super.performClick()
        return true
    }
}
