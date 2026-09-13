package app.murmur.android

import android.content.Context
import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import app.murmur.android.cloud.AccountMode
import app.murmur.android.cloud.CloudConfig
import app.murmur.android.cloud.CloudSync
import app.murmur.android.cloud.SyncStatus
import app.murmur.android.dictation.DictationController
import app.murmur.android.dictation.DictationState
import app.murmur.android.history.HistoryStore
import app.murmur.android.history.RecordingStore
import app.murmur.android.overlay.OverlayEditor
import app.murmur.android.settings.MurmurSettings
import app.murmur.android.settings.SettingsStore
import app.murmur.android.settings.ThemeMode
import app.murmur.android.ui.AccountGateScreen
import app.murmur.android.ui.AccountScreen
import app.murmur.android.ui.AppShell
import app.murmur.android.ui.AppearanceScreen
import app.murmur.android.ui.DictationButtonScreen
import app.murmur.android.ui.DictionaryScreen
import app.murmur.android.ui.DrawerRow
import app.murmur.android.ui.HistoryScreen
import app.murmur.android.ui.HomeScreen
import app.murmur.android.ui.LanguageScreen
import app.murmur.android.ui.OnboardingScreen
import app.murmur.android.ui.PermissionsScreen
import app.murmur.android.ui.Route
import app.murmur.android.ui.Section
import app.murmur.android.ui.SpeechModelScreen
import app.murmur.android.ui.StyleScreen
import app.murmur.android.ui.TryItScreen
import app.murmur.android.ui.UpdatesScreen
import app.murmur.android.ui.components.Glyph
import app.murmur.android.ui.components.GlyphIcon
import app.murmur.android.ui.rememberNavigator
import app.murmur.android.ui.rememberPermissionState
import app.murmur.android.ui.murmurStt
import app.murmur.android.ui.rememberInferenceView
import app.murmur.android.ui.syncLabel
import app.murmur.android.ui.theme.Murmur
import app.murmur.android.ui.theme.MurmurTheme
import app.murmur.android.update.UpdateManager
import app.murmur.android.update.UpdatePhase
import com.clerk.api.Clerk
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

class MainActivity : ComponentActivity() {
    /** A screen another part of the app asked for (the pill's "own model" chip); consumed once shown. */
    private val requestedRoute = MutableStateFlow<Route?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        requestedRoute.value = routeFrom(intent)
        val store = SettingsStore.get(this)
        // A forced light/dark choice picks the window theme too, so the frame before Compose draws
        // (and the window background behind the keyboard) already has the right brightness.
        when (store.get().themeMode) {
            ThemeMode.LIGHT -> setTheme(R.style.Theme_Murmur_Light)
            ThemeMode.DARK -> setTheme(R.style.Theme_Murmur_Dark)
            ThemeMode.SYSTEM -> Unit
        }
        enableEdgeToEdge()
        val config = (application as? MurmurApplication)?.cloudConfig ?: CloudConfig.OFF
        setContent {
            val settings by store.flow.collectAsState()
            MurmurTheme(settings) {
                Box(Modifier.fillMaxSize().background(Murmur.colors.paper)) {
                    Root(config, store, settings, requestedRoute, onRouteShown = { requestedRoute.value = null })
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        routeFrom(intent)?.let { requestedRoute.value = it }
    }

    override fun onResume() {
        super.onResume()
        val updates = UpdateManager.get(this)
        updates.foreground = true
        updates.onAppVisible()
    }

    override fun onPause() {
        UpdateManager.get(this).foreground = false
        super.onPause()
    }

    override fun onStop() {
        // Never leave the full-screen drag surface behind when the user leaves the app.
        OverlayEditor.stop()
        super.onStop()
    }

    companion object {
        private const val EXTRA_ROUTE = "app.murmur.android.ROUTE"

        /** An intent that brings Murmur to the front on [route] (the activity is a single task). */
        fun intentFor(context: Context, route: Route): Intent =
            Intent(context, MainActivity::class.java).putExtra(EXTRA_ROUTE, route.name)

        fun routeFrom(intent: Intent?): Route? =
            intent?.getStringExtra(EXTRA_ROUTE)?.let { name -> Route.entries.firstOrNull { it.name == name } }
    }
}

/**
 * Cloud builds: account gate -> onboarding -> settings. Local builds: onboarding -> settings.
 * A device that signed in before keeps working from its local mirror when Clerk cannot be reached.
 */
@Composable
private fun Root(
    config: CloudConfig,
    store: SettingsStore,
    settings: MurmurSettings,
    requestedRoute: StateFlow<Route?>,
    onRouteShown: () -> Unit
) {
    val clerkReady by (if (config.enabled) Clerk.isInitialized else remember { MutableStateFlow(true) }).collectAsState()
    val clerkUser by (if (config.enabled) Clerk.userFlow else remember { MutableStateFlow(null) }).collectAsState()
    val syncStatus = CloudSync.get()?.status?.collectAsState()?.value
    val signedIn = config.enabled && clerkUser != null
    val firstName = clerkUser?.firstName ?: syncStatus?.user?.name?.substringBefore(' ')

    val accountWanted = config.accountMode == AccountMode.REQUIRED ||
        (config.accountMode == AccountMode.OPTIONAL && !settings.accountSkipped)
    if (accountWanted && !signedIn) {
        val offlineFallback = clerkReady && settings.lastSignedInUserId.isNotEmpty()
        if (!offlineFallback) {
            AccountGateScreen(config, onSkip = { store.update { it.copy(accountSkipped = true) } })
            return
        }
    }

    if (!settings.onboardingComplete) {
        OnboardingScreen(
            store = store,
            signedIn = signedIn,
            accountOnboarded = syncStatus?.user?.onboardingCompletedAt != null,
            firstName = firstName,
            onFinish = {
                store.update { it.copy(onboardingComplete = true) }
                CloudSync.get()?.completeOnboarding()
            }
        )
        return
    }

    Main(config, store, settings, signedIn, firstName, syncStatus, requestedRoute, onRouteShown)
}

/**
 * The app proper: the drawer of sections down the left, and the current section in front of it.
 * The drawer's foot mirrors the desktop sidebar: the live state of the button, the account, the
 * version.
 */
@Composable
private fun Main(
    config: CloudConfig,
    store: SettingsStore,
    settings: MurmurSettings,
    signedIn: Boolean,
    firstName: String?,
    syncStatus: SyncStatus?,
    requestedRoute: StateFlow<Route?>,
    onRouteShown: () -> Unit
) {
    val c = Murmur.colors
    val context = LocalContext.current
    val navigator = rememberNavigator()
    val requested by requestedRoute.collectAsState()
    LaunchedEffect(requested) {
        requested?.let {
            navigator.select(it)
            onRouteShown()
        }
    }
    val permissions = rememberPermissionState()
    val dictation by DictationController.state.collectAsState()
    val updateState by UpdateManager.get(context).state.collectAsState()
    val inference = rememberInferenceView(settings)
    val modelReady = inference.sttReady
    val ready = permissions.allGranted && modelReady
    // Murmur models only need a signed-in account; the user's own provider needs the model screen.
    val modelRoute = if (inference.routing.murmurStt) Route.ACCOUNT else Route.MODEL
    val sections = sections(
        cloud = config.enabled,
        modelReady = modelReady,
        permissionsGranted = permissions.allGranted,
        updateReady = updateState.phase == UpdatePhase.READY
    )

    AppShell(
        navigator = navigator,
        sections = sections,
        footer = { select ->
            val (label, hint, dot, pulsing) = when {
                dictation is DictationState.Listening -> StatusRow("Listening", "the button is recording", c.ember, true)
                dictation is DictationState.Processing -> StatusRow("Working", (dictation as DictationState.Processing).label, c.ember, true)
                !modelReady -> StatusRow(
                    "Setup needed",
                    if (inference.routing.murmurStt) "sign in to use Murmur's models" else "connect a speech model",
                    c.ember, false
                )
                !permissions.allGranted -> StatusRow("Setup needed", "${permissions.total - permissions.granted} permissions to allow", c.ember, false)
                else -> StatusRow("Ready", "tap the button beside your keyboard", c.sage, false)
            }
            DrawerRow(
                label = label,
                hint = hint,
                dot = dot,
                pulsing = pulsing,
                onClick = if (ready) null else ({ select(if (!modelReady) modelRoute else Route.PERMISSIONS) })
            )
            if (config.enabled) {
                Spacer(Modifier.height(8.dp))
                val name = syncStatus?.user?.name?.takeIf { it.isNotBlank() } ?: firstName
                val email = syncStatus?.user?.email
                DrawerRow(
                    label = if (signedIn) name ?: email ?: "Your account" else "Not signed in",
                    hint = if (signedIn && syncStatus != null) {
                        listOfNotNull(if (name != null) email else null, syncLabel(syncStatus)).joinToString(" · ")
                    } else {
                        "sign in to sync your dictionary and style"
                    },
                    leading = { Avatar((name ?: email ?: "?").first().uppercaseChar(), signedIn) },
                    onClick = { select(Route.ACCOUNT) }
                )
            }
            Spacer(Modifier.height(12.dp))
            Text(
                "Murmur ${BuildConfig.VERSION_NAME}",
                style = Murmur.type.labelSmall,
                color = c.inkMuted,
                modifier = Modifier.padding(start = 14.dp, bottom = 4.dp)
            )
        }
    ) { entry, nav ->
        when (entry.route) {
            Route.HOME -> HomeScreen(config, settings, signedIn, firstName, syncStatus, nav, onOpen = navigator::open)
            Route.HISTORY -> HistoryScreen(HistoryStore.get(context), store, RecordingStore.get(context), nav)
            Route.BUTTON -> DictationButtonScreen(store, settings, nav)
            Route.MODEL -> SpeechModelScreen(store, settings, nav)
            Route.LANGUAGE -> LanguageScreen(store, settings, signedIn, nav)
            Route.STYLE -> StyleScreen(store, settings, nav)
            Route.DICTIONARY -> DictionaryScreen(store, synced = signedIn, nav = nav)
            Route.APPEARANCE -> AppearanceScreen(store, settings, nav)
            Route.PERMISSIONS -> PermissionsScreen(nav)
            Route.UPDATES -> UpdatesScreen(store, settings, nav)
            Route.TRY_IT -> TryItScreen(store, settings, nav)
            Route.ACCOUNT -> AccountScreen(
                config, store, nav,
                onSignIn = { store.update { it.copy(accountSkipped = false) } }
            )
        }
    }
}

private data class StatusRow(val label: String, val hint: String, val dot: Color, val pulsing: Boolean)

/** The drawer's sections, grouped like the desktop sidebar; the ember dots mark unfinished setup. */
private fun sections(cloud: Boolean, modelReady: Boolean, permissionsGranted: Boolean, updateReady: Boolean): List<Section> = buildList {
    add(Section(Route.HOME, "Home", Glyph.HOME))
    add(Section(Route.HISTORY, "History", Glyph.HISTORY))
    add(Section(Route.DICTIONARY, "Dictionary", Glyph.DICTIONARY, group = "Personalize"))
    add(Section(Route.STYLE, "Style", Glyph.STYLE))
    add(Section(Route.BUTTON, "Dictation button", Glyph.BUTTON, group = "Setup"))
    add(Section(Route.MODEL, "Speech model", Glyph.MODEL, attention = !modelReady))
    add(Section(Route.LANGUAGE, "Language", Glyph.LANGUAGE))
    add(Section(Route.APPEARANCE, "Appearance", Glyph.APPEARANCE))
    add(Section(Route.PERMISSIONS, "Permissions", Glyph.PERMISSIONS, attention = !permissionsGranted))
    add(Section(Route.UPDATES, "Updates", Glyph.UPDATES, attention = updateReady))
    add(Section(Route.TRY_IT, "Try it", Glyph.TRY_IT))
    if (cloud) add(Section(Route.ACCOUNT, "Account", Glyph.ACCOUNT, group = "Cloud"))
}

/** The account's initial in a small disc; hollow when nobody is signed in. */
@Composable
private fun Avatar(initial: Char, signedIn: Boolean) {
    val c = Murmur.colors
    Box(
        Modifier
            .size(28.dp)
            .clip(CircleShape)
            .background(if (signedIn) c.ember else c.paperRaised),
        contentAlignment = Alignment.Center
    ) {
        if (signedIn) {
            Text(initial.toString(), style = Murmur.type.labelSmall, color = c.onEmber)
        } else {
            GlyphIcon(Glyph.ACCOUNT, c.inkSoft, size = 16.dp)
        }
    }
}
