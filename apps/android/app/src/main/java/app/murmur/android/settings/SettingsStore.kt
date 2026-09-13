package app.murmur.android.settings

import android.content.Context
import android.content.SharedPreferences
import app.murmur.android.BuildConfig
import app.murmur.android.overlay.OverlayAnchor
import app.murmur.android.overlay.OverlayLayout
import app.murmur.android.overlay.OverlayLayoutCodec
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

enum class SttKind(val id: String) {
    OPENAI_COMPATIBLE("openai-compatible"),
    DEEPGRAM("deepgram"),
    ELEVENLABS("elevenlabs");

    companion object {
        fun from(id: String?): SttKind = entries.firstOrNull { it.id == id } ?: OPENAI_COMPATIBLE
    }
}

/**
 * Where a model runs: the Murmur instance's managed models (cloud builds only) or a provider the
 * user configured on this phone. Mirrors `inferenceSourceSchema` in the desktop settings; see
 * app.murmur.android.inference.Inference for how the effective source is decided.
 */
enum class InferenceSource(val id: String) {
    MURMUR("murmur"),
    CUSTOM("custom");

    companion object {
        fun from(id: String?): InferenceSource = entries.firstOrNull { it.id == id } ?: MURMUR
    }
}

enum class FormattingMode(val id: String) {
    OFF("off"),
    LIGHT("light"),
    SMART("smart");

    companion object {
        fun from(id: String?): FormattingMode = entries.firstOrNull { it.id == id } ?: SMART
    }
}

enum class Tone(val id: String) {
    AUTO("auto"),
    CASUAL("casual"),
    NEUTRAL("neutral"),
    PROFESSIONAL("professional");

    companion object {
        fun from(id: String?): Tone = entries.firstOrNull { it.id == id } ?: AUTO
    }
}

/** Resting shape of the floating dictation button. */
enum class OverlayShape(val id: String) {
    /** The classic wide pill (64 x 36 dp). */
    PILL("pill"),
    /** A compact circle (36 dp) small enough to sit on the keyboard's own toolbar row. */
    CIRCLE("circle");

    companion object {
        fun from(id: String?): OverlayShape = entries.firstOrNull { it.id == id } ?: PILL
    }
}

/** Light, dark, or whatever the system is using. */
enum class ThemeMode(val id: String) {
    SYSTEM("system"),
    LIGHT("light"),
    DARK("dark");

    companion object {
        fun from(id: String?): ThemeMode = entries.firstOrNull { it.id == id } ?: SYSTEM
    }
}

/**
 * Seed colours for the app's own Material 3 palette, used when wallpaper (Material You) colours are
 * unavailable (Android 8 to 11) or turned off. Same seeds as the desktop presets.
 */
enum class AccentPreset(val id: String, val label: String, val seed: Int) {
    CORAL("coral", "Coral", 0xFFFF5A36.toInt()),
    AMBER("amber", "Amber", 0xFFF59E0B.toInt()),
    GREEN("green", "Green", 0xFF2FA84F.toInt()),
    TEAL("teal", "Teal", 0xFF14B8A6.toInt()),
    BLUE("blue", "Blue", 0xFF3B82F6.toInt()),
    INDIGO("indigo", "Indigo", 0xFF6366F1.toInt()),
    VIOLET("violet", "Violet", 0xFF8B5CF6.toInt()),
    PINK("pink", "Pink", 0xFFEC4899.toInt());

    companion object {
        fun from(id: String?): AccentPreset = entries.firstOrNull { it.id == id } ?: CORAL
    }
}

/**
 * Mirror of the desktop settings that matter on Android. Same defaults as the desktop
 * schema in apps/desktop/src/shared/settings.ts, minus desktop-only concerns (hotkeys,
 * injection strategies). The overlay button's shape and spots, and the appearance
 * (theme, wallpaper colours, accent) are device settings (screens and keyboards differ)
 * and are never synced.
 */
data class MurmurSettings(
    /**
     * Managed Murmur models by default in cloud builds; ignored (always the user's own provider) in
     * local builds. The `stt…` and `llm…` connection fields describe the user's own provider only.
     * A build seeded with MURMUR_BASE_URL starts on the seeded provider.
     */
    val sttSource: InferenceSource = if (BuildConfig.DEFAULT_BASE_URL.isBlank()) InferenceSource.MURMUR else InferenceSource.CUSTOM,
    val llmSource: InferenceSource = if (BuildConfig.DEFAULT_BASE_URL.isBlank()) InferenceSource.MURMUR else InferenceSource.CUSTOM,
    val sttKind: SttKind = SttKind.OPENAI_COMPATIBLE,
    val sttBaseUrl: String = BuildConfig.DEFAULT_BASE_URL,
    val sttApiKey: String = BuildConfig.DEFAULT_API_KEY,
    val sttModel: String = BuildConfig.DEFAULT_STT_MODEL,
    val sttFallbackModel: String = "",
    val language: String = "auto",
    val sttTimeoutMs: Int = 45_000,
    /**
     * How speech becomes text. The engine (packages/text-engine, ported in app.murmur.android.text)
     * does the language work with the formatting model and adapts to the destination on its own;
     * what is left to choose is whether to use the model, how the result should sound, the trailing
     * space, and anything you want to tell the model.
     */
    val formattingMode: FormattingMode = FormattingMode.SMART,
    val tone: Tone = Tone.AUTO,
    val trailingSpace: Boolean = true,
    /** Free-form guidance for the model ("British spelling", "dates as ISO"). Synced. */
    val llmInstructions: String = "",
    val llmSameAsStt: Boolean = true,
    val llmBaseUrl: String = "",
    val llmApiKey: String = "",
    val llmModel: String = BuildConfig.DEFAULT_LLM_MODEL,
    // More generous than desktop (8 s): mobile networks and reasoning models need headroom,
    // and the rule-based cleanup still covers any timeout.
    val llmTimeoutMs: Int = 15_000,
    val maxDurationSec: Int = 300,
    /**
     * Store the audio of every dictation next to its History entry (play it back, send it again).
     * Off, only failed dictations keep their audio, and only until they succeed or are deleted.
     */
    val keepRecordings: Boolean = true,
    /**
     * Personal dictionary: STT prompt hint, LLM spelling list and enforced in the text. Synced with
     * the account when signed in (same shape as the desktop app and the backend).
     */
    val dictionaryEntries: List<DictionaryEntry> = emptyList(),
    /** Debug aid: dictate the bundled fixture clip instead of the microphone. */
    val useFixtureAudio: Boolean = false,
    /** Resting shape of the floating dictation button. */
    val overlayShape: OverlayShape = OverlayShape.PILL,
    /**
     * The spots the floating button can be parked on (relative to the keyboard), which of them it
     * rests on, and whether they are locked into one row or column.
     */
    val overlayLayout: OverlayLayout = OverlayLayout.DEFAULT,
    /** Light, dark or follow the system. */
    val themeMode: ThemeMode = ThemeMode.SYSTEM,
    /** Material You: take the palette from the wallpaper (Android 12+). Ignored on older devices. */
    val dynamicColor: Boolean = true,
    /** Seed for Murmur's own palette when wallpaper colours are off or unavailable. */
    val accent: AccentPreset = AccentPreset.CORAL,
    /** Device-level first-run flow finished (permissions, provider). */
    val onboardingComplete: Boolean = false,
    /** `optional` account mode: the user chose to keep using Murmur without an account. */
    val accountSkipped: Boolean = false,
    /** Stable per-install id reported to the account's device list. */
    val deviceId: String = "",
    /** Clerk user id of the last signed-in account (lets the app open offline). */
    val lastSignedInUserId: String = "",
    /** Account whose cloud data absorbed this device's pre-account local dictionary. */
    val importedForUserId: String = "",
    // Device-local update preferences (never synced), same defaults as the desktop app.
    /** Look for new releases when the app opens and daily from the accessibility service. */
    val updateAutoCheck: Boolean = true,
    /** Download new versions and install them once nothing is being dictated. */
    val updateAutoInstall: Boolean = true,
    /** Offer pre-releases (vX.Y.Z-beta.N); always on while running a pre-release build. */
    val updateIncludePrereleases: Boolean = false,
    /** Version the user dismissed; withheld until a newer one appears. */
    val updateSkippedVersion: String = "",
    /** Totals of everything dictated on this phone (see [DictationStats]); never synced as such. */
    val stats: DictationStats = DictationStats.EMPTY
) {
    val dictionaryTerms: List<String>
        get() = dictionaryEntries.map { it.word.trim() }.filter { it.isNotEmpty() }

    fun llmConnection(): Triple<String, String, String> =
        if (llmSameAsStt) Triple(sttBaseUrl, sttApiKey, llmModel)
        else Triple(llmBaseUrl, llmApiKey, llmModel)
}

/** Who made a change: the user on this device, or the sync engine mirroring the account. */
enum class SettingsOrigin { LOCAL, CLOUD }

class SettingsStore(context: Context) {
    private val prefs: SharedPreferences =
        context.applicationContext.getSharedPreferences("murmur_settings", Context.MODE_PRIVATE)

    private val _flow = MutableStateFlow(read())
    val flow: StateFlow<MurmurSettings> = _flow

    /** Emits (previous, next, origin) for every change so the sync engine can diff local edits. */
    private val listeners = java.util.concurrent.CopyOnWriteArrayList<(MurmurSettings, MurmurSettings, SettingsOrigin) -> Unit>()

    init {
        migrate()
    }

    fun get(): MurmurSettings = _flow.value

    fun update(origin: SettingsOrigin = SettingsOrigin.LOCAL, transform: (MurmurSettings) -> MurmurSettings) {
        val previous = _flow.value
        val next = transform(previous)
        if (next == previous) return
        write(next)
        _flow.value = next
        for (l in listeners) l(previous, next, origin)
    }

    fun update(transform: (MurmurSettings) -> MurmurSettings) = update(SettingsOrigin.LOCAL, transform)

    fun addListener(listener: (MurmurSettings, MurmurSettings, SettingsOrigin) -> Unit) {
        listeners.add(listener)
    }

    fun removeListener(listener: (MurmurSettings, MurmurSettings, SettingsOrigin) -> Unit) {
        listeners.remove(listener)
    }

    /** One-time upgrades of persisted data. */
    private fun migrate() {
        val legacy = prefs.getString("dictionary", null)
        if (!legacy.isNullOrBlank() && !prefs.contains("dictionaryEntries")) {
            val entries = DictionaryCodec.fromLegacy(legacy)
            update(SettingsOrigin.LOCAL) { it.copy(dictionaryEntries = entries) }
            prefs.edit().remove("dictionary").apply()
        }
        // Installs from before model sources existed: one that had connected its own speech provider
        // keeps using it (and its formatting server) instead of being moved to the instance's models.
        if (!prefs.contains("sttSource") && prefs.contains("sttBaseUrl") && _flow.value.sttBaseUrl.isNotBlank()) {
            update(SettingsOrigin.LOCAL) {
                it.copy(
                    sttSource = InferenceSource.CUSTOM,
                    llmSource = if (prefs.contains("llmSource")) it.llmSource else InferenceSource.CUSTOM
                )
            }
        }
        // The rule-based cleanup knobs went away with the text engine; their keys are dead weight.
        val stale = LEGACY_CLEANUP_KEYS.filter { prefs.contains(it) }
        if (stale.isNotEmpty()) prefs.edit().apply { for (k in stale) remove(k) }.apply()
        // Models the hosted providers retired (RetiredModels) are swapped for the recommended
        // replacement once; from then on whatever the store names is the user's own choice.
        if (prefs.getInt(MODEL_MIGRATION_KEY, 0) < MODEL_MIGRATION) {
            update(SettingsOrigin.LOCAL) { RetiredModels.migrate(it) }
            prefs.edit().putInt(MODEL_MIGRATION_KEY, MODEL_MIGRATION).apply()
        }
        if (_flow.value.deviceId.isEmpty()) {
            update(SettingsOrigin.CLOUD) { it.copy(deviceId = java.util.UUID.randomUUID().toString()) }
        }
        // Builds before spots stored one button position; read() already turned it into a layout.
        if (prefs.contains(LEGACY_ANCHOR_X) || prefs.contains(LEGACY_OFFSET_DP)) {
            write(_flow.value)
            prefs.edit().remove(LEGACY_ANCHOR_X).remove(LEGACY_OFFSET_DP).apply()
        }
    }

    private fun readOverlayLayout(default: OverlayLayout): OverlayLayout {
        OverlayLayoutCodec.decode(prefs.getString("overlayLayout", null))?.let { return it }
        if (prefs.contains(LEGACY_ANCHOR_X) || prefs.contains(LEGACY_OFFSET_DP)) {
            val legacy = OverlayAnchor(
                xFraction = prefs.getFloat(LEGACY_ANCHOR_X, OverlayAnchor.DEFAULT_X).coerceIn(0f, 1f),
                offsetDp = prefs.getFloat(LEGACY_OFFSET_DP, OverlayAnchor.DEFAULT_OFFSET_DP)
            )
            return if (legacy == OverlayAnchor.DEFAULT) default else OverlayLayout.fromLegacy(legacy)
        }
        return default
    }

    private fun read(): MurmurSettings {
        val d = MurmurSettings()
        return MurmurSettings(
            sttSource = InferenceSource.from(prefs.getString("sttSource", d.sttSource.id)),
            llmSource = InferenceSource.from(prefs.getString("llmSource", d.llmSource.id)),
            sttKind = SttKind.from(prefs.getString("sttKind", d.sttKind.id)),
            sttBaseUrl = prefs.getString("sttBaseUrl", d.sttBaseUrl) ?: d.sttBaseUrl,
            sttApiKey = prefs.getString("sttApiKey", d.sttApiKey) ?: d.sttApiKey,
            sttModel = prefs.getString("sttModel", d.sttModel) ?: d.sttModel,
            sttFallbackModel = prefs.getString("sttFallbackModel", d.sttFallbackModel) ?: "",
            language = prefs.getString("language", d.language) ?: "auto",
            sttTimeoutMs = prefs.getInt("sttTimeoutMs", d.sttTimeoutMs),
            formattingMode = FormattingMode.from(prefs.getString("formattingMode", d.formattingMode.id)),
            tone = Tone.from(prefs.getString("tone", d.tone.id)),
            trailingSpace = prefs.getBoolean("trailingSpace", d.trailingSpace),
            llmInstructions = prefs.getString("llmInstructions", d.llmInstructions) ?: "",
            llmSameAsStt = prefs.getBoolean("llmSameAsStt", d.llmSameAsStt),
            llmBaseUrl = prefs.getString("llmBaseUrl", d.llmBaseUrl) ?: "",
            llmApiKey = prefs.getString("llmApiKey", d.llmApiKey) ?: "",
            llmModel = prefs.getString("llmModel", d.llmModel) ?: d.llmModel,
            llmTimeoutMs = prefs.getInt("llmTimeoutMs", d.llmTimeoutMs),
            maxDurationSec = prefs.getInt("maxDurationSec", d.maxDurationSec),
            keepRecordings = prefs.getBoolean("keepRecordings", d.keepRecordings),
            dictionaryEntries = DictionaryCodec.decode(prefs.getString("dictionaryEntries", null)),
            useFixtureAudio = prefs.getBoolean("useFixtureAudio", d.useFixtureAudio),
            overlayShape = OverlayShape.from(prefs.getString("overlayShape", d.overlayShape.id)),
            overlayLayout = readOverlayLayout(d.overlayLayout),
            themeMode = ThemeMode.from(prefs.getString("themeMode", d.themeMode.id)),
            dynamicColor = prefs.getBoolean("dynamicColor", d.dynamicColor),
            accent = AccentPreset.from(prefs.getString("accent", d.accent.id)),
            onboardingComplete = prefs.getBoolean("onboardingComplete", d.onboardingComplete),
            accountSkipped = prefs.getBoolean("accountSkipped", d.accountSkipped),
            deviceId = prefs.getString("deviceId", d.deviceId) ?: "",
            lastSignedInUserId = prefs.getString("lastSignedInUserId", d.lastSignedInUserId) ?: "",
            importedForUserId = prefs.getString("importedForUserId", d.importedForUserId) ?: "",
            updateAutoCheck = prefs.getBoolean("updateAutoCheck", d.updateAutoCheck),
            updateAutoInstall = prefs.getBoolean("updateAutoInstall", d.updateAutoInstall),
            updateIncludePrereleases = prefs.getBoolean("updateIncludePrereleases", d.updateIncludePrereleases),
            updateSkippedVersion = prefs.getString("updateSkippedVersion", d.updateSkippedVersion) ?: "",
            stats = DictationStats(
                totalWords = prefs.getInt("statsTotalWords", 0),
                totalSessions = prefs.getInt("statsTotalSessions", 0),
                totalSpeechMs = prefs.getLong("statsTotalSpeechMs", 0L),
                streakDays = prefs.getInt("statsStreakDays", 0),
                lastSessionDay = prefs.getString("statsLastSessionDay", "") ?: ""
            )
        )
    }

    private fun write(s: MurmurSettings) {
        prefs.edit()
            .putString("sttSource", s.sttSource.id)
            .putString("llmSource", s.llmSource.id)
            .putString("sttKind", s.sttKind.id)
            .putString("sttBaseUrl", s.sttBaseUrl)
            .putString("sttApiKey", s.sttApiKey)
            .putString("sttModel", s.sttModel)
            .putString("sttFallbackModel", s.sttFallbackModel)
            .putString("language", s.language)
            .putInt("sttTimeoutMs", s.sttTimeoutMs)
            .putString("formattingMode", s.formattingMode.id)
            .putString("tone", s.tone.id)
            .putBoolean("trailingSpace", s.trailingSpace)
            .putString("llmInstructions", s.llmInstructions)
            .putBoolean("llmSameAsStt", s.llmSameAsStt)
            .putString("llmBaseUrl", s.llmBaseUrl)
            .putString("llmApiKey", s.llmApiKey)
            .putString("llmModel", s.llmModel)
            .putInt("llmTimeoutMs", s.llmTimeoutMs)
            .putInt("maxDurationSec", s.maxDurationSec)
            .putBoolean("keepRecordings", s.keepRecordings)
            .putString("dictionaryEntries", DictionaryCodec.encode(s.dictionaryEntries))
            .putBoolean("useFixtureAudio", s.useFixtureAudio)
            .putString("overlayShape", s.overlayShape.id)
            .putString("overlayLayout", OverlayLayoutCodec.encode(s.overlayLayout))
            .putString("themeMode", s.themeMode.id)
            .putBoolean("dynamicColor", s.dynamicColor)
            .putString("accent", s.accent.id)
            .putBoolean("onboardingComplete", s.onboardingComplete)
            .putBoolean("accountSkipped", s.accountSkipped)
            .putString("deviceId", s.deviceId)
            .putString("lastSignedInUserId", s.lastSignedInUserId)
            .putString("importedForUserId", s.importedForUserId)
            .putBoolean("updateAutoCheck", s.updateAutoCheck)
            .putBoolean("updateAutoInstall", s.updateAutoInstall)
            .putBoolean("updateIncludePrereleases", s.updateIncludePrereleases)
            .putString("updateSkippedVersion", s.updateSkippedVersion)
            .putInt("statsTotalWords", s.stats.totalWords)
            .putInt("statsTotalSessions", s.stats.totalSessions)
            .putLong("statsTotalSpeechMs", s.stats.totalSpeechMs)
            .putInt("statsStreakDays", s.stats.streakDays)
            .putString("statsLastSessionDay", s.stats.lastSessionDay)
            .apply()
    }

    companion object {
        private const val LEGACY_ANCHOR_X = "overlayAnchorX"
        private const val LEGACY_OFFSET_DP = "overlayOffsetDp"
        /** Bump when RetiredModels gains entries that existing installs should be moved off. */
        private const val MODEL_MIGRATION = 1
        private const val MODEL_MIGRATION_KEY = "modelMigration"
        private val LEGACY_CLEANUP_KEYS = listOf(
            "removeFillers", "hesitations", "hesitationPhrases", "collapseRepeats", "repetitionScope",
            "spokenCommands", "selfCorrections", "autoCapitalize", "lists", "listStyle", "bulletMarker",
            "numbers", "llmFreedom", "llmStructure", "llmMinWords"
        )

        @Volatile
        private var instance: SettingsStore? = null

        /** Newline-separated string list; phrases never contain newlines. */
        internal fun encodeList(items: List<String>): String = items.joinToString("\n")
        internal fun decodeList(raw: String?): List<String> =
            raw?.split('\n')?.map { it.trim() }?.filter { it.isNotEmpty() } ?: emptyList()

        fun get(context: Context): SettingsStore =
            instance ?: synchronized(this) {
                instance ?: SettingsStore(context).also { instance = it }
            }
    }
}
