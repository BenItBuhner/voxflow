package app.murmur.android.cloud

import android.content.Context
import android.os.Build
import android.util.Log
import app.murmur.android.BuildConfig
import app.murmur.android.settings.DictationStats
import app.murmur.android.settings.DictionaryEntry
import app.murmur.android.settings.MurmurSettings
import app.murmur.android.settings.SettingsOrigin
import app.murmur.android.settings.SettingsStore
import com.clerk.api.Clerk
import dev.convex.android.AuthState
import dev.convex.android.ConvexClientWithAuth
import dev.convex.android.WebSocketState
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeoutOrNull

private const val TAG = "MurmurCloud"
private const val RETRY_MS = 15_000L
private const val ONBOARDING_VERSION = 1.0

enum class SyncPhase { DISABLED, SIGNED_OUT, CONNECTING, SYNCING, SYNCED, OFFLINE, ERROR }

data class SyncStatus(
    val phase: SyncPhase,
    val signedIn: Boolean,
    val authenticated: Boolean,
    val connected: Boolean,
    val pendingOps: Int,
    val user: UserDto?,
    val devices: List<DeviceDto>,
    val error: String?,
    /** The account's totals across every device, once loaded; null means show the phone's own. */
    val stats: DictationStats? = null,
    /** Managed-model availability and allowance; null until the account is connected. */
    val inference: InferenceStatusDto? = null
) {
    companion object {
        val DISABLED = SyncStatus(SyncPhase.DISABLED, false, false, false, 0, null, emptyList(), null)
    }
}

/**
 * Android counterpart of the desktop sync engine (apps/desktop/src/main/cloud/sync-engine.ts).
 * Clerk reports who is signed in; Convex subscriptions deliver the account's dictionary and style
 * preferences; local edits are diffed into an idempotent outbox and replayed. The dictionary the
 * dictation pipeline reads is always derive(server snapshot, pending ops), so the app works offline.
 */
class CloudSync private constructor(
    private val app: Context,
    val config: CloudConfig,
    private val settings: SettingsStore
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val client: ConvexClientWithAuth<ClerkCredentials>? =
        if (config.enabled) ConvexClientWithAuth(config.convexUrl, ClerkAuthProvider(), scope) else null
    private val outbox = Outbox(app)
    private val flushMutex = Mutex()

    private val _status = MutableStateFlow(SyncStatus.DISABLED)
    val status: StateFlow<SyncStatus> = _status

    private var signedIn = false
    private var authenticated = false
    private var connected = false
    private var error: String? = null
    private var user: UserDto? = null
    private var devices: List<DeviceDto> = emptyList()
    private var inference: InferenceStatusDto? = null
    /** The instance rejected the `day` argument: an older backend, asked the old way from then on. */
    @Volatile private var statusWithoutDay = false
    private var serverDictionary: List<DictionaryEntryDto>? = null
    private var serverPreferences: PreferencesDto? = null
    private var serverStats: StatsDto? = null
    private var preferencesLoaded = false
    private var mirrorPrefs: StylePreferences = StylePreferences.of(settings.get())
    private var subscriptions: Job? = null
    private var generation = 0
    @Volatile private var applying = false

    private val settingsListener: (MurmurSettings, MurmurSettings, SettingsOrigin) -> Unit =
        { previous, next, origin -> onSettingsChange(previous, next, origin) }

    fun start() {
        val convex = client ?: return
        settings.addListener(settingsListener)
        scope.launch {
            convex.webSocketStateFlow.collect { state ->
                val was = connected
                connected = state == WebSocketState.CONNECTED
                if (connected && !was) {
                    error = null
                    launch { flush() }
                }
                publish()
            }
        }
        scope.launch {
            convex.authState.collect { state ->
                authenticated = state is AuthState.Authenticated
                if (state is AuthState.Authenticated) onAuthenticated(state.userInfo)
                publish()
            }
        }
        scope.launch {
            combine(Clerk.isInitialized, Clerk.userFlow) { ready, user -> ready to user?.id }
                .distinctUntilChanged()
                .collect { (ready, userId) ->
                    if (!ready) return@collect
                    if (userId != null) onSignedIn(userId) else onSignedOut()
                }
        }
        publish()
        Log.i(TAG, "sync engine started (${config.accountMode}, ${config.convexUrl})")
    }

    // ---- auth ---------------------------------------------------------------------------------

    private fun onSignedIn(userId: String) {
        val convex = client ?: return
        val wasSignedIn = signedIn
        signedIn = true
        val previousUser = settings.get().lastSignedInUserId
        if (wasSignedIn && previousUser == userId) return
        generation++
        outbox.bind(userId)
        settings.update(SettingsOrigin.CLOUD) { it.copy(lastSignedInUserId = userId) }
        publish()
        scope.launch {
            convex.loginFromCache().onFailure {
                error = it.message
                Log.w(TAG, "could not authenticate with Convex", it)
                publish()
            }
        }
    }

    private fun onSignedOut() {
        if (!signedIn) {
            publish()
            return
        }
        Log.i(TAG, "signed out; clearing account data from this device")
        signedIn = false
        generation++
        subscriptions?.cancel()
        subscriptions = null
        authenticated = false
        user = null
        devices = emptyList()
        inference = null
        serverDictionary = null
        serverPreferences = null
        serverStats = null
        preferencesLoaded = false
        error = null
        outbox.clear()
        settings.update(SettingsOrigin.CLOUD) { it.copy(dictionaryEntries = emptyList(), lastSignedInUserId = "") }
        mirrorPrefs = StylePreferences.of(settings.get())
        scope.launch { client?.logout(app) }
        publish()
    }

    private fun onAuthenticated(credentials: ClerkCredentials) {
        val convex = client ?: return
        val gen = generation
        scope.launch {
            try {
                user = convex.mutation<UserDto>("users:ensure")
                heartbeat()
                importLocalData(credentials.userId)
                if (gen != generation) return@launch
                subscribe(gen)
                error = null
                flush()
            } catch (e: Exception) {
                if (gen != generation) return@launch
                error = e.message
                Log.e(TAG, "account connection failed; retrying", e)
                delay(RETRY_MS)
                if (gen == generation && authenticated) onAuthenticated(credentials)
            }
            publish()
        }
    }

    private suspend fun importLocalData(userId: String) {
        val convex = client ?: return
        val s = settings.get()
        if (s.importedForUserId == userId) return
        val entries = s.dictionaryEntries.filter { it.word.isNotBlank() }
        Log.i(TAG, "merging ${entries.size} local words into the account")
        for (chunk in entries.chunked(500)) {
            convex.mutation("dictionary:importMany", mapOf(
                "entries" to chunk.map { e ->
                    buildMap<String, Any?> {
                        put("word", e.word)
                        put("aliases", e.aliases)
                        put("fuzzy", e.fuzzy)
                        if (e.createdAt > 0) put("createdAt", e.createdAt.toDouble())
                    }
                }
            ))
        }
        if (s.onboardingComplete) {
            convex.mutation("users:completeOnboarding", mapOf("version" to ONBOARDING_VERSION))
        }
        // Dictations made before signing in count towards the account, like the desktop app does.
        if (s.stats.totalSessions > 0) {
            convex.mutation<StatsDto>("stats:importLocal", mapOf(
                "totalWords" to s.stats.totalWords.toDouble(),
                "totalSessions" to s.stats.totalSessions.toDouble(),
                "totalSpeechMs" to s.stats.totalSpeechMs.toDouble(),
                "streakDays" to s.stats.streakDays.toDouble(),
                "lastSessionDay" to s.stats.lastSessionDay
            ))
        }
        settings.update(SettingsOrigin.CLOUD) { it.copy(importedForUserId = userId) }
    }

    // ---- subscriptions ------------------------------------------------------------------------

    private fun subscribe(gen: Int) {
        val convex = client ?: return
        subscriptions?.cancel()
        subscriptions = scope.launch {
            launch {
                convex.subscribe<List<DictionaryEntryDto>>("dictionary:list").collect { result ->
                    if (gen != generation) return@collect
                    result.onSuccess { list ->
                        serverDictionary = list
                        outbox.update { SyncReducers.pruneAcked(it, list.map { d -> d.id }.toSet()) }
                        applyDerived()
                    }.onFailure { error = it.message }
                    publish()
                }
            }
            launch {
                convex.subscribe<PreferencesDto?>("preferences:get").collect { result ->
                    if (gen != generation) return@collect
                    result.onSuccess { prefs ->
                        serverPreferences = prefs
                        if (!preferencesLoaded) {
                            preferencesLoaded = true
                            // First contact: a device without account preferences pushes its own.
                            if (prefs == null) {
                                val local = StylePreferences.of(settings.get())
                                outbox.update { SyncReducers.queuePreferences(it, local, newOpId()) }
                                launch { flush() }
                            }
                        }
                        applyDerived()
                    }.onFailure { error = it.message }
                    publish()
                }
            }
            launch {
                convex.subscribe<UserDto?>("users:me").collect { result ->
                    if (gen != generation) return@collect
                    result.onSuccess { user = it }
                    publish()
                }
            }
            launch {
                convex.subscribe<List<DeviceDto>>("devices:list").collect { result ->
                    if (gen != generation) return@collect
                    result.onSuccess { devices = it }
                    publish()
                }
            }
            launch {
                convex.subscribe<StatsDto?>("stats:get").collect { result ->
                    if (gen != generation) return@collect
                    result.onSuccess { serverStats = it }.onFailure { error = it.message }
                    publish()
                }
            }
            launch { subscribeStatus(gen) }
        }
    }

    /**
     * The managed-model status for today (UTC), asked again when the day changes so the rolling
     * windows (words this week, dictations today) and their reset times stay right. An instance
     * that does not accept the `day` argument yet answers with an argument error; then the status
     * is asked the old way, without windows.
     */
    private suspend fun subscribeStatus(gen: Int) = coroutineScope {
        val convex = client ?: return@coroutineScope
        while (gen == generation) {
            val withDay = !statusWithoutDay
            val args: Map<String, Any?> = if (withDay) mapOf("day" to InferenceStatusDto.currentUtcDay()) else emptyMap()
            val refused = CompletableDeferred<Unit>()
            val subscription = launch {
                convex.subscribe<InferenceStatusDto>("inference:status", args).collect { result ->
                    if (gen != generation) return@collect
                    result.onSuccess { inference = it }.onFailure { e ->
                        if (withDay && e.message?.contains("ArgumentValidationError", ignoreCase = true) == true) {
                            Log.i(TAG, "instance does not take a day for inference:status; asking without it")
                            statusWithoutDay = true
                            refused.complete(Unit)
                        } else {
                            Log.w(TAG, "inference status: ${e.message}")
                        }
                    }
                    publish()
                }
            }
            // Until the day turns or the argument is refused (without the day there is no turning:
            // the wait only ends with the scope, on sign-out or a new generation).
            if (withDay) withTimeoutOrNull(InferenceStatusDto.msUntilNextUtcDay()) { refused.await() } else refused.await()
            subscription.cancel()
        }
    }

    private fun applyDerived() {
        val s = settings.get()
        val derived = SyncReducers.deriveDictionary(serverDictionary, s.dictionaryEntries, outbox.ops)
        val remote = serverPreferences
        val pendingPrefs = outbox.ops.filterIsInstance<SyncOp.PreferencesUpdate>().lastOrNull()?.prefs
        applying = true
        try {
            settings.update(SettingsOrigin.CLOUD) { current ->
                var next = current.copy(dictionaryEntries = derived)
                if (preferencesLoaded && remote != null) next = applyRemotePreferences(next, remote)
                if (pendingPrefs != null) next = applyRemotePreferences(next, pendingPrefs.toDto())
                next
            }
        } finally {
            applying = false
        }
        mirrorPrefs = StylePreferences.of(settings.get())
    }

    // ---- local changes -> outbox ------------------------------------------------------------

    private fun onSettingsChange(previous: MurmurSettings, next: MurmurSettings, origin: SettingsOrigin) {
        if (origin == SettingsOrigin.CLOUD || applying) {
            mirrorPrefs = StylePreferences.of(next)
            return
        }
        if (!signedIn) {
            mirrorPrefs = StylePreferences.of(next)
            return
        }
        var touched = false
        val serverIds = serverDictionary?.map { it.id }?.toSet() ?: emptySet()
        val diff = SyncReducers.diffDictionary(previous.dictionaryEntries, next.dictionaryEntries)
        for (e in diff.added + diff.changed) {
            touched = true
            outbox.update { ops ->
                SyncReducers.queueUpsert(
                    ops,
                    SyncOp.DictionaryUpsert(
                        id = newOpId(),
                        localId = e.id,
                        remoteId = SyncReducers.remoteIdFor(e.id, serverIds, ops),
                        entry = e
                    )
                )
            }
        }
        for (e in diff.removed) {
            touched = true
            outbox.update { ops ->
                SyncReducers.queueRemove(ops, e.id, SyncReducers.remoteIdFor(e.id, serverIds, ops), newOpId())
            }
        }
        val prefs = StylePreferences.of(next)
        if (prefs != mirrorPrefs) {
            touched = true
            outbox.update { SyncReducers.queuePreferences(it, prefs, newOpId()) }
        }
        mirrorPrefs = prefs
        if (touched) {
            publish()
            scope.launch { flush() }
        }
    }

    /** Called after every finished dictation. */
    fun recordSession(sessionId: String, words: Int, speechMs: Long) {
        if (!config.enabled || !signedIn || words <= 0) return
        outbox.update { it + SyncOp.StatsRecord(newOpId(), sessionId, words, speechMs, localDay()) }
        publish()
        scope.launch { flush() }
    }

    /** Account-level onboarding finished on this device. */
    fun completeOnboarding() {
        if (!config.enabled || !signedIn) return
        outbox.update { ops -> ops.filterNot { it is SyncOp.CompleteOnboarding } + SyncOp.CompleteOnboarding(newOpId()) }
        user = user?.copy(onboardingCompletedAt = System.currentTimeMillis().toDouble())
        publish()
        scope.launch { flush() }
    }

    fun syncNow() {
        scope.launch { flush() }
    }

    suspend fun signOut() {
        client?.logout(app)
    }

    suspend fun deleteMyData(): Result<Unit> {
        val convex = client ?: return Result.failure(IllegalStateException("Cloud is not configured"))
        if (!authenticated) return Result.failure(IllegalStateException("Not connected to your account"))
        return try {
            outbox.update { emptyList() }
            convex.mutation("users:deleteMyData")
            Result.success(Unit)
        } catch (e: Exception) {
            Result.failure(e)
        }
    }

    // ---- outbox flush -------------------------------------------------------------------------

    private suspend fun flush() {
        val convex = client ?: return
        if (!authenticated) return
        if (!flushMutex.tryLock()) return
        val gen = generation
        try {
            while (gen == generation && authenticated) {
                val op = outbox.ops.firstOrNull { !(it is SyncOp.DictionaryUpsert && it.acked) } ?: break
                try {
                    send(convex, op)
                    if (gen != generation) break
                    error = null
                    applyDerived()
                } catch (e: Exception) {
                    if (gen != generation) break
                    if (isPermanentError(e)) {
                        Log.w(TAG, "dropping ${op::class.simpleName}: ${e.message}")
                        outbox.remove(op.id)
                        applyDerived()
                        continue
                    }
                    error = e.message
                    Log.w(TAG, "sync failed, retrying in ${RETRY_MS / 1000}s: ${e.message}")
                    scope.launch {
                        delay(RETRY_MS)
                        flush()
                    }
                    break
                }
            }
        } finally {
            flushMutex.unlock()
            publish()
        }
    }

    private suspend fun send(convex: ConvexClientWithAuth<ClerkCredentials>, op: SyncOp) {
        when (op) {
            is SyncOp.DictionaryUpsert -> {
                val id = convex.mutation<String>("dictionary:upsert", buildMap {
                    if (op.remoteId != null) put("id", op.remoteId)
                    put("word", op.entry.word)
                    put("aliases", op.entry.aliases)
                    put("fuzzy", op.entry.fuzzy)
                    if (op.entry.createdAt > 0) put("createdAt", op.entry.createdAt.toDouble())
                })
                outbox.update { SyncReducers.ack(it, op.id, id) }
                return
            }
            is SyncOp.DictionaryRemove ->
                convex.mutation<Boolean>("dictionary:remove", mapOf("id" to op.remoteId))
            is SyncOp.PreferencesUpdate ->
                convex.mutation<PreferencesDto>("preferences:update", op.prefs.patchArgs(null))
            is SyncOp.StatsRecord ->
                convex.mutation<Map<String, Double?>>("stats:recordSession", mapOf(
                    "words" to op.words.toDouble(),
                    "speechMs" to op.speechMs.toDouble(),
                    "day" to op.day,
                    "sessionId" to op.sessionId
                ))
            is SyncOp.CompleteOnboarding ->
                convex.mutation<UserDto>("users:completeOnboarding", mapOf("version" to ONBOARDING_VERSION))
        }
        outbox.remove(op.id)
    }

    private suspend fun heartbeat() {
        val convex = client ?: return
        val s = settings.get()
        convex.mutation<DeviceDto>("devices:heartbeat", mapOf(
            "deviceId" to s.deviceId,
            "name" to (Build.MODEL?.takeIf { it.isNotBlank() } ?: "Android phone"),
            "platform" to "android",
            "appVersion" to BuildConfig.VERSION_NAME
        ))
    }

    private fun publish() {
        val pending = outbox.pending
        val phase = when {
            !config.enabled -> SyncPhase.DISABLED
            !signedIn -> SyncPhase.SIGNED_OUT
            !connected -> SyncPhase.OFFLINE
            !authenticated -> SyncPhase.CONNECTING
            error != null -> SyncPhase.ERROR
            pending > 0 -> SyncPhase.SYNCING
            else -> SyncPhase.SYNCED
        }
        val stats = serverStats?.let { SyncReducers.deriveStats(settings.get().stats, it, outbox.ops) }
        _status.value = SyncStatus(phase, signedIn, authenticated, connected, pending, user, devices, error, stats, inference)
    }

    companion object {
        @Volatile private var instance: CloudSync? = null

        fun init(context: Context, config: CloudConfig, settings: SettingsStore): CloudSync =
            instance ?: synchronized(this) {
                instance ?: CloudSync(context.applicationContext, config, settings).also {
                    instance = it
                    it.start()
                }
            }

        fun get(): CloudSync? = instance

        fun localDay(now: Date = Date()): String = SimpleDateFormat("yyyy-MM-dd", Locale.US).format(now)

        /** Server-side validation/ownership errors: retrying would wedge the queue. */
        fun isPermanentError(e: Throwable): Boolean {
            val message = e.message ?: return false
            if (message.contains("Not authenticated", ignoreCase = true)) return false
            return e is dev.convex.android.ConvexError ||
                Regex("Server Error|ArgumentValidationError|Uncaught Error|ReturnsValidationError", RegexOption.IGNORE_CASE)
                    .containsMatchIn(message)
        }
    }
}

private fun StylePreferences.toDto() = PreferencesDto(
    formatting = FormattingPreferencesDto(
        mode = mode,
        tone = tone,
        trailingSpace = trailingSpace,
        llmInstructions = llmInstructions
    ),
    language = language
)
