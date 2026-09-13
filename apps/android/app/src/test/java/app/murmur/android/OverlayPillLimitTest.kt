package app.murmur.android

import android.app.Activity
import android.graphics.Bitmap
import android.graphics.Canvas
import android.os.SystemClock
import android.view.MotionEvent
import android.widget.FrameLayout
import app.murmur.android.dictation.DictationState
import app.murmur.android.inference.LimitNotice
import app.murmur.android.overlay.Box
import app.murmur.android.overlay.OverlayAnchor
import app.murmur.android.overlay.OverlayLayout
import app.murmur.android.overlay.OverlayPillView
import app.murmur.android.settings.OverlayShape
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import org.robolectric.shadows.ShadowLooper
import org.robolectric.shadows.ShadowSystemClock
import java.time.Duration

private const val SCREEN_W = 1080
private const val SCREEN_H = 2400
private const val KEYBOARD_TOP = 1500
private const val DENSITY = 3f
private const val FRAME_MS = 8L
private const val TOUCH_PAD = 6 * DENSITY
private const val UPGRADE = "https://murmur.app/account?upgrade=yearly"

/**
 * A refusal on a plan limit: the pill grows into a two-line notice with Upgrade, Own model and
 * Retry chips (each its own tap target) and a dismiss cross; a Pro cap gets no Upgrade; the pill
 * comes back to its resting size afterwards.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "xxhdpi")
class OverlayPillLimitTest {

    private class RecordingHost : OverlayPillView.Host {
        val canvas = ArrayList<Box>()
        val touch = ArrayList<Box>()
        override fun applyCanvasFrame(frame: Box) { canvas += frame }
        override fun applyTouchFrame(frame: Box) { touch += frame }
    }

    private lateinit var view: OverlayPillView
    private lateinit var host: RecordingHost
    private val retries = ArrayList<String>()
    private val upgrades = ArrayList<String>()
    private var ownModel = 0
    private var dismissals = 0
    private var micTaps = 0
    private val bitmap = Bitmap.createBitmap(SCREEN_W, SCREEN_H, Bitmap.Config.ARGB_8888)
    private val canvas = Canvas(bitmap)
    private var downTime = 0L

    private val words = LimitNotice(
        limit = "wordsPerWeek", plan = "free", planState = "free", used = 503.0, allowed = 500.0,
        resetsAt = System.currentTimeMillis() + 2 * 86_400_000L, upgradeUrl = UPGRADE,
        message = "This week's 500 free words are used up."
    )

    @Before
    fun setUp() {
        host = RecordingHost()
        val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
        view = OverlayPillView(activity).apply {
            this.host = this@OverlayPillLimitTest.host
            onRetryTap = { retries += it }
            onUpgradeTap = { upgrades += it }
            onOwnModelTap = { ownModel++ }
            onDismissTap = { dismissals++ }
            onMicTap = { micTaps++ }
        }
        activity.setContentView(view, FrameLayout.LayoutParams(SCREEN_W, SCREEN_H))
        ShadowLooper.idleMainLooper()
        view.configure(OverlayShape.PILL, OverlayLayout(listOf(OverlayAnchor(0.5f, 30f))))
        view.setScreen(SCREEN_W, SCREEN_H, KEYBOARD_TOP)
        view.render(DictationState.Idle)
        frames(10)
    }

    private fun frames(n: Int) {
        repeat(n) {
            view.draw(canvas)
            ShadowSystemClock.advanceBy(Duration.ofMillis(FRAME_MS))
            ShadowLooper.idleMainLooper()
        }
    }

    private fun settle() = frames(120)

    private fun tap(x: Float, y: Float) {
        val now = SystemClock.uptimeMillis()
        downTime = now
        val down = MotionEvent.obtain(downTime, now, MotionEvent.ACTION_DOWN, x, y, 0)
        view.onScreenTouch(down, x, y)
        down.recycle()
        frames(2)
        val up = MotionEvent.obtain(downTime, SystemClock.uptimeMillis(), MotionEvent.ACTION_UP, x, y, 0)
        view.onScreenTouch(up, x, y)
        up.recycle()
        frames(1)
    }

    private fun pill(): Box = host.touch.last().inflate(-TOUCH_PAD)

    /** Where the chips sit: right-aligned along the bottom row, Retry last, Upgrade first. */
    private fun chipRowY(box: Box): Float = box.bottom - 12 * DENSITY - 15 * DENSITY

    @Test
    fun `a plan limit grows a two-line notice with Upgrade, Own model and Retry`() {
        view.render(DictationState.Error("The server took too long to respond", retryId = "entry-1"))
        settle()
        val retryable = pill()

        view.render(DictationState.Error(words.message, retryId = "entry-1", limit = words))
        settle()
        val notice = pill()
        assertTrue("taller than a pill: ${retryable.height} -> ${notice.height}", notice.height > retryable.height + 40 * DENSITY)
        assertTrue("about as wide as the screen allows", notice.width > 320 * DENSITY)

        // The dismiss cross sits at the top right (12 dp margin, 14 dp radius, on the title row).
        val titleY = notice.top + 12 * DENSITY + 10 * DENSITY
        tap(notice.right - 26 * DENSITY, titleY)
        assertEquals(1, dismissals)

        // Along the chip row from the right: Retry, then Own model, then Upgrade.
        val y = chipRowY(notice)
        tap(notice.right - 12 * DENSITY - 20 * DENSITY, y)
        assertEquals(listOf("entry-1"), retries)
        val retryW = 24 * DENSITY + measure("Retry")
        val ownW = 24 * DENSITY + measure("Own model")
        tap(notice.right - 12 * DENSITY - retryW - 6 * DENSITY - ownW / 2f, y)
        assertEquals(1, ownModel)
        val upgradeW = 24 * DENSITY + measure("Upgrade")
        tap(notice.right - 12 * DENSITY - retryW - 6 * DENSITY - ownW - 6 * DENSITY - upgradeW / 2f, y)
        assertEquals(listOf(UPGRADE), upgrades)

        // The text itself is not a button, and the mic never fires from the notice.
        tap(notice.left + 60 * DENSITY, titleY)
        assertEquals(1, dismissals)
        assertEquals(0, micTaps)

        view.render(DictationState.Idle)
        settle()
        assertTrue(pill().height < retryable.height)
    }

    @Test
    fun `a Pro cap offers no Upgrade and a refusal without a recording has no Retry`() {
        val cap = words.copy(limit = "sttSecondsPerMonth", plan = "pro", planState = "pro", used = 216_000.0, allowed = 216_000.0, upgradeUrl = null)
        view.render(DictationState.Error("Fair-use cap reached", retryId = null, limit = cap))
        settle()
        val notice = pill()
        val y = chipRowY(notice)
        // The only chip is Own model, at the right edge.
        tap(notice.right - 12 * DENSITY - 20 * DENSITY, y)
        assertEquals(1, ownModel)
        assertTrue(retries.isEmpty())
        // Left of it there is nothing to tap.
        val ownW = 24 * DENSITY + measure("Own model")
        tap(notice.right - 12 * DENSITY - ownW - 6 * DENSITY - 30 * DENSITY, y)
        assertTrue(upgrades.isEmpty())
        assertEquals(1, ownModel)
    }

    @Test
    fun `a rate limit is a plain retryable error, not a notice`() {
        val rate = words.copy(limit = "requestsPerMinute", used = 20.0, allowed = 20.0)
        view.render(DictationState.Error("Too many requests; try again in 30s", retryId = "entry-3", limit = rate))
        settle()
        val box = pill()
        assertTrue("stays a single-row pill: ${box.height}", box.height < 60 * DENSITY)
        tap(box.right - 75 * DENSITY, box.centerY)
        assertEquals(listOf("entry-3"), retries)
    }

    /** Width of a chip label in the pill's small text paint (12 sp, sans-serif-medium). */
    private fun measure(label: String): Float {
        val paint = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG).apply {
            textSize = 12f * view.resources.displayMetrics.scaledDensity
            typeface = android.graphics.Typeface.create("sans-serif-medium", android.graphics.Typeface.NORMAL)
        }
        return paint.measureText(label)
    }
}
