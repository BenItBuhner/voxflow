package app.murmur.android.dictation

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.os.Build
import android.util.Log
import app.murmur.android.BuildConfig
import app.murmur.android.audio.Recorder
import app.murmur.android.audio.SAMPLE_RATE
import app.murmur.android.audio.Wav
import app.murmur.android.cloud.CloudSync
import app.murmur.android.history.HistoryEntry
import app.murmur.android.history.HistoryStore
import app.murmur.android.history.LlmOutcome
import app.murmur.android.history.RecordingStore
import app.murmur.android.history.StageTimings
import app.murmur.android.inference.Inference
import app.murmur.android.inference.InferenceRouter
import app.murmur.android.inference.LimitNotice
import app.murmur.android.service.RecordingService
import app.murmur.android.settings.DictationStats
import app.murmur.android.settings.FormattingMode
import app.murmur.android.settings.InferenceSource
import app.murmur.android.settings.MurmurSettings
import app.murmur.android.settings.SettingsStore
import app.murmur.android.settings.SttKind
import app.murmur.android.stt.SttException
import app.murmur.android.stt.adaptiveThreshold
import app.murmur.android.stt.lastVoicedSec
import app.murmur.android.stt.transcribeComplete
import app.murmur.android.text.AppContext
import app.murmur.android.text.DictionaryTerm
import app.murmur.android.text.Engine
import app.murmur.android.text.FormatContext
import app.murmur.android.text.FormatInput
import app.murmur.android.text.FormatOutcome
import app.murmur.android.text.FormatResult
import app.murmur.android.text.FormatStatus
import app.murmur.android.text.STT_BASE_PROMPT
import app.murmur.android.text.buildSttPrompt
import app.murmur.android.text.classifyPackage
import app.murmur.android.text.countWords
import app.murmur.android.text.finish
import app.murmur.android.text.resolveStyle
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.util.UUID

private const val TAG = "MurmurDictation"

/** How long an error that can be retried stays on the pill, waiting for the user. */
private const val RETRY_HOLD_MS = 15_000L
/** A limit refusal is read, not glanced at; a text inserted unformatted deserves a beat more too. */
private const val LIMIT_HOLD_MS = 20_000L
private const val SOFT_LIMIT_HOLD_MS = 5_000L

sealed class DictationState {
    data object Idle : DictationState()
    data class Listening(val elapsedSec: Int, val level: Float) : DictationState()
    data class Processing(val label: String) : DictationState()

    /**
     * [limit]: the text went in with rule-based cleanup only because the Murmur instance paused or
     * refused the formatting model on a plan limit; the pill says so in passing.
     */
    data class Success(val message: String, val limit: LimitNotice? = null) : DictationState()

    /**
     * [retryId]: the history entry whose stored recording can be sent again. The pill then shows a
     * Retry button and stays up until the user acts on it (or gives up on them after a while).
     * [limit]: the plan limit that refused the request; the pill explains it and offers Upgrade and
     * the user's own provider as the ways forward, beside Retry.
     */
    data class Error(val message: String, val retryId: String? = null, val limit: LimitNotice? = null) : DictationState()
}

/** One run of the pipeline: a dictation that was just spoken, or a stored one sent again. */
private class Run(
    val id: String,
    /** Speech captured, for the entry and the stats. */
    val recordMs: Long,
    /** File name of the stored audio, when it was kept. */
    val recording: String?,
    /** Sent again: the failed entry this run replaces. */
    val previous: HistoryEntry? = null,
    /** How many times this audio has now been sent for transcription. */
    val attempts: Int = 1,
    /**
     * Insert the text into the focused field. A retry started from the History screen only copies
     * it: the focused field, if any, is Murmur's own search box.
     */
    val insert: Boolean = true
)

/** Where the final text should go. */
interface TextSink {
    /** @return null on success, or a user-facing error message. */
    suspend fun insert(text: String, pressEnter: Boolean): String?

    /** Package name of the app owning the focused field, for tone/context rules. */
    fun focusedPackage(): String

    /**
     * The text before the cursor in the focused field, when the platform can read it. The model
     * continues it naturally (mid-sentence means no capital, an ongoing list keeps its markers).
     */
    suspend fun precedingText(): String? = null
}

/**
 * Orchestrates one dictation from pill tap to inserted text: record -> STT (with fallback
 * model retry) -> the text engine (the formatting model on the raw transcript, verified, with the
 * rule-based cleanup as the fallback) -> inject into the focused field. Mirrors the desktop
 * session orchestrator.
 */
object DictationController {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val recorder = Recorder()

    private val _state = MutableStateFlow<DictationState>(DictationState.Idle)
    val state: StateFlow<DictationState> = _state

    var sink: TextSink? = null

    private var listeningJob: Job? = null
    private var resetJob: Job? = null
    @Volatile private var startedAt = 0L
    /** When the user stopped listening; speech duration is [stoppedAt] - [startedAt]. */
    @Volatile private var stoppedAt = 0L
    /** Id of the dictation in flight: the history entry and the account's idempotent stats record. */
    @Volatile private var sessionId = ""

    val isListening: Boolean get() = _state.value is DictationState.Listening
    val isBusy: Boolean get() = _state.value is DictationState.Processing

    fun toggle(context: Context) {
        when {
            isListening -> stopAndInsert(context)
            isBusy -> Unit
            else -> start(context)
        }
    }

    /**
     * The bundled sample clip only ever replaces the microphone in debug builds. A release install
     * on a phone must never end up dictating the same canned sentence because a debugging switch
     * was left on.
     */
    private fun fixtureMode(settings: MurmurSettings): Boolean = settings.useFixtureAudio && BuildConfig.DEBUG

    fun start(context: Context) {
        if (isListening || isBusy) return
        resetJob?.cancel()
        val appContext = context.applicationContext
        val settings = SettingsStore.get(appContext).get()
        startedAt = System.currentTimeMillis()
        sessionId = UUID.randomUUID().toString()

        if (fixtureMode(settings)) {
            // Debug aid for emulators without a microphone: "listen" briefly, then dictate
            // the bundled fixture clip through the real provider pipeline.
            _state.value = DictationState.Listening(0, 0.4f)
            listeningJob = scope.launch {
                while (isActive) {
                    val elapsed = ((System.currentTimeMillis() - startedAt) / 1000).toInt()
                    _state.value = DictationState.Listening(elapsed, 0.3f + (Math.random() * 0.4f).toFloat())
                    delay(100)
                }
            }
            return
        }

        try {
            RecordingService.start(appContext)
            recorder.start(settings.maxDurationSec) { stopAndInsert(appContext) }
        } catch (e: Exception) {
            Log.e(TAG, "recorder start failed", e)
            RecordingService.stop(appContext)
            showTransient(DictationState.Error(friendlyError(e)))
            return
        }
        _state.value = DictationState.Listening(0, 0f)
        listeningJob = scope.launch {
            while (isActive) {
                val elapsed = ((System.currentTimeMillis() - startedAt) / 1000).toInt()
                _state.value = DictationState.Listening(elapsed, recorder.level)
                delay(80)
            }
        }
    }

    fun cancel(context: Context) {
        if (!isListening) return
        listeningJob?.cancel()
        listeningJob = null
        recorder.cancel()
        RecordingService.stop(context.applicationContext)
        _state.value = DictationState.Idle
    }

    fun stopAndInsert(context: Context) {
        if (!isListening) return
        val appContext = context.applicationContext
        listeningJob?.cancel()
        listeningJob = null
        stoppedAt = System.currentTimeMillis()
        val settings = SettingsStore.get(appContext).get()
        _state.value = DictationState.Processing("Transcribing…")

        scope.launch {
            val id = sessionId
            var run: Run? = null
            try {
                val pcm: ShortArray = if (fixtureMode(settings)) {
                    loadFixture(appContext)
                } else {
                    val recorded = recorder.stop()
                    RecordingService.stop(appContext)
                    if (recorded.size < SAMPLE_RATE * 15 / 100) {
                        showTransient(DictationState.Error("Too short"))
                        return@launch
                    }
                    if (Wav.peakDb(recorded) < -48.0) {
                        showTransient(DictationState.Error("No speech detected"))
                        return@launch
                    }
                    recorded
                }
                // Store the audio before anything can go wrong with it: a failed request is retried
                // from this file, and a kept recording is what History plays back.
                val started = Run(id, recordMs = (stoppedAt - startedAt).coerceAtLeast(0), recording = storeRecording(appContext, id, pcm))
                run = started
                process(started, pcm, settings, appContext, InferenceRouter.get(appContext))
            } catch (e: Exception) {
                Log.e(TAG, "dictation failed", e)
                RecordingService.stop(appContext)
                val message = friendlyError(e)
                val failed = run ?: Run(id, recordMs = (stoppedAt - startedAt).coerceAtLeast(0), recording = null)
                recordFailure(appContext, settings, failed, raw = "", error = message)
                showError(message, failed, planLimitOf(e))
            } finally {
                run?.let { releaseRecording(appContext, it) }
            }
        }
    }

    /**
     * Send a dictation's stored audio through the pipeline again. With [insert] the result goes into
     * the field that is still focused (the pill's Retry button, moments after the failure); without
     * it the text is copied to the clipboard and kept in History (the History screen's Retry).
     *
     * @return null when the retry is under way, or why it could not start.
     */
    fun retry(context: Context, id: String, insert: Boolean = true): String? {
        if (isListening) return "Finish the current dictation first"
        if (isBusy) return "Still working on the last one"
        val appContext = context.applicationContext
        val entry = HistoryStore.get(appContext).get(id) ?: return "This dictation is no longer in History"
        if (entry.finalText.isNotEmpty()) return "This dictation already has its text"
        val recording = entry.recording?.takeIf { RecordingStore.get(appContext).has(it) }
            ?: return "The recording of this dictation was not kept"
        val decoded = RecordingStore.get(appContext).read(recording) ?: return "The recording could not be read"
        val settings = SettingsStore.get(appContext).get()
        resetJob?.cancel()
        sessionId = id
        stoppedAt = System.currentTimeMillis()
        startedAt = stoppedAt - entry.speechMs
        _state.value = DictationState.Processing("Transcribing…")
        val run = Run(
            id = id,
            recordMs = entry.speechMs,
            recording = recording,
            previous = entry,
            attempts = entry.attempts + 1,
            insert = insert
        )
        Log.i(TAG, "retry #${run.attempts} of ${id.take(8)}${if (insert) "" else " (copy only)"}")
        scope.launch {
            try {
                val (pcm, rate) = decoded
                process(run, Wav.resample(pcm, rate, SAMPLE_RATE), settings, appContext, InferenceRouter.get(appContext))
            } catch (e: Exception) {
                Log.e(TAG, "retry failed", e)
                val message = friendlyError(e)
                recordFailure(appContext, settings, run, raw = "", error = message)
                showError(message, run, planLimitOf(e))
            } finally {
                releaseRecording(appContext, run)
            }
        }
        return null
    }

    /** The user waved the pill's message away. */
    fun dismiss() {
        if (_state.value is DictationState.Error || _state.value is DictationState.Success) {
            resetJob?.cancel()
            _state.value = DictationState.Idle
        }
    }

    private fun storeRecording(context: Context, id: String, pcm: ShortArray): String? = try {
        RecordingStore.get(context).save(id, pcm, SAMPLE_RATE)
    } catch (e: Exception) {
        Log.w(TAG, "could not store the recording", e)
        null
    }

    /** After a run: audio that no History entry refers to any more has nothing to be kept for. */
    private fun releaseRecording(context: Context, run: Run) {
        val name = run.recording ?: return
        if (HistoryStore.get(context).get(run.id)?.recording != name) RecordingStore.get(context).delete(name)
    }

    private suspend fun process(run: Run, pcm: ShortArray, s: MurmurSettings, context: Context, router: InferenceRouter) {
        val recordMs = run.recordMs
        // 1. STT, and make sure the transcript reaches the end of the speech. The router decides
        // whether the clip goes to the instance's model or the user's own provider.
        val sttStarted = System.currentTimeMillis()
        val resolved = router.stt()
        val prompt = buildSttPrompt(s.dictionaryTerms)
        val threshold = adaptiveThreshold(pcm, SAMPLE_RATE, -48.0)
        val complete = transcribeComplete(
            pcm = pcm,
            sampleRate = SAMPLE_RATE,
            speechEndSec = lastVoicedSec(pcm, SAMPLE_RATE, threshold),
            thresholdDb = threshold,
            prompt = prompt,
            // Resumed tails keep the style hint but never the vocabulary: a prompt that ends with a
            // term the speaker says next is exactly what makes Whisper stop early.
            tailPrompt = STT_BASE_PROMPT,
            log = { Log.w(TAG, it) }
        ) { wav, p -> router.transcribe(resolved, wav, p) }
        val stt = complete.output
        if (complete.resumed > 0) {
            Log.i(TAG, "transcript recovered ${"%.1f".format(complete.recoveredSec)}s of speech in ${complete.resumed} extra request(s)")
        }
        val raw = stt.text.trim()
        val sttMs = System.currentTimeMillis() - sttStarted
        Log.i(TAG, "stt done in ${stt.latencyMs}ms: ${raw.take(80)}")
        if (raw.isEmpty() ||
            (stt.noSpeechProb != null && stt.noSpeechProb > 0.85 && countWords(raw) <= 2)
        ) {
            recordFailure(
                context, s, run, raw, "Nothing heard", StageTimings(recordMs = recordMs, sttMs = sttMs),
                provider = resolved.provider, model = resolved.cfg.model
            )
            showError("Nothing heard", run)
            return
        }

        // 2. Text. The engine gets the raw transcript plus everything it should know about the
        // destination; against a Murmur instance it runs on the gateway, otherwise here.
        val focusedPackage = sink?.focusedPackage() ?: ""
        val app: AppContext = classifyPackage(focusedPackage)
        val style = resolveStyle(s, app)
        val formatStarted = System.currentTimeMillis()
        var final: String
        var pressEnter = false
        var stages: List<String> = emptyList()
        var llm = LlmOutcome.SKIPPED
        var llmDetail: String? = null
        var llmMs = 0L
        // The text goes in, but the formatting model was paused or refused on a plan limit.
        var softLimit: LimitNotice? = null
        if (style.mode == FormattingMode.OFF) {
            final = raw + if (style.trailingSpace) " " else ""
            llmDetail = "formatting off"
        } else {
            val input = FormatInput(
                transcript = raw,
                mode = style.mode,
                context = FormatContext(
                    category = app.category,
                    tone = style.tone,
                    app = focusedPackage.takeIf { it.isNotBlank() && it != context.packageName },
                    language = s.language,
                    // A copy-only retry has no target field; what is focused is Murmur's own screen.
                    precedingText = if (run.insert && style.mode == FormattingMode.SMART) runCatching { sink?.precedingText() }.getOrNull() else null,
                    instructions = style.instructions.takeIf { it.isNotEmpty() },
                    dictionary = s.dictionaryEntries.map { DictionaryTerm(it.word, it.aliases, it.fuzzy) }
                ),
                dictionary = s.dictionaryEntries
            )
            var formatted: FormatResult
            if (style.mode != FormattingMode.SMART) {
                formatted = Engine.formatTranscript(input, null)
            } else {
                _state.value = DictationState.Processing("Formatting…")
                // A formatting model that cannot be reached (signed out of Murmur, no token, gateway
                // down) or refused on a plan limit is not an error for the dictation: the rule-based
                // text goes in and History says why. A Murmur instance past the fair-use cap answers
                // with the rule-based text itself and says which limit paused the model.
                formatted = try {
                    router.formatter().format(input).also { softLimit = it.limit }
                } catch (e: Exception) {
                    Log.w(TAG, "formatting unavailable, using rule-based text: ${e.message}")
                    softLimit = planLimitOf(e)
                    Engine.formatTranscript(input, null)
                        .copy(status = FormatStatus(FormatOutcome.FAILED, friendlyError(e), 0))
                }
            }
            val finished = finish(formatted.text, app.category, s.dictionaryEntries, style.trailingSpace)
            final = finished.text
            pressEnter = formatted.pressEnter
            stages = formatted.stages + finished.stages
            llmMs = formatted.llmMs
            llm = when (formatted.status.outcome) {
                FormatOutcome.USED -> LlmOutcome.USED
                FormatOutcome.REJECTED -> LlmOutcome.REJECTED
                FormatOutcome.FAILED -> LlmOutcome.FAILED
                FormatOutcome.SKIPPED -> LlmOutcome.SKIPPED
            }
            llmDetail = formatted.status.detail ?: formatted.status.retriedAfter?.let { "used after a strict retry ($it)" }
            when (formatted.status.outcome) {
                FormatOutcome.USED -> Log.i(TAG, "model formatting used (${formatted.status.attempts} attempt(s), ${llmMs}ms)")
                FormatOutcome.REJECTED -> Log.w(TAG, "model output rejected (${formatted.status.detail}); using rule-based text")
                FormatOutcome.FAILED -> Log.w(TAG, "model formatting failed, using rule-based text: ${formatted.status.detail}")
                FormatOutcome.SKIPPED -> Unit
            }
        }
        val formatMs = (System.currentTimeMillis() - formatStarted - llmMs).coerceAtLeast(0)

        val timings = StageTimings(recordMs = recordMs, sttMs = sttMs, formatMs = formatMs, llmMs = llmMs)
        if (final.isBlank()) {
            recordFailure(context, s, run, raw, "Nothing to insert", timings, resolved.provider, resolved.cfg.model)
            showError("Nothing to insert", run)
            return
        }

        // 4. Inject into the focused field, or only copy when the text has nowhere to go right now.
        val currentSink = sink
        if (run.insert && currentSink == null) {
            recordFailure(context, s, run, raw, "Accessibility service not running", timings, resolved.provider, resolved.cfg.model)
            showError("Accessibility service not running", run)
            return
        }
        _state.value = DictationState.Processing(if (run.insert) "Inserting…" else "Copying…")
        val injectStarted = System.currentTimeMillis()
        val error = if (run.insert && currentSink != null) currentSink.insert(final, pressEnter) else copyToClipboard(context, final)
        val wordCount = countWords(final)
        val now = System.currentTimeMillis()
        // The audio stays with a successful dictation only if the user wants recordings kept.
        val recording = if (error == null && !s.keepRecordings) null else run.recording
        val entry = HistoryEntry(
            id = run.id,
            createdAt = run.previous?.createdAt ?: now,
            rawText = raw,
            finalText = if (error == null) final.trimEnd() else "",
            wordCount = if (error == null) wordCount else 0,
            speechMs = recordMs,
            appName = if (run.insert) appLabel(context, focusedPackage) else run.previous?.appName,
            provider = resolved.provider,
            model = resolved.cfg.model,
            injected = error == null && run.insert,
            llmUsed = llm == LlmOutcome.USED,
            llm = llm,
            llmDetail = llmDetail,
            stages = stages,
            timings = timings.copy(injectMs = now - injectStarted, totalMs = now - stoppedAt),
            error = error,
            recording = recording,
            attempts = run.attempts
        )
        val history = HistoryStore.get(context)
        if (run.previous != null) history.replace(entry) else history.add(entry)
        if (error == null) {
            Log.i(TAG, "${if (run.insert) "inserted" else "copied"} $wordCount words in ${entry.timings.totalMs}ms${if (run.attempts > 1) " (attempt ${run.attempts})" else ""}")
            showTransient(
                DictationState.Success(if (run.insert) "Inserted" else "Copied", softLimit),
                if (softLimit != null) SOFT_LIMIT_HOLD_MS else 1500
            )
            SettingsStore.get(context).update { current ->
                current.copy(stats = current.stats.record(entry.wordCount, entry.speechMs, DictationStats.localDay(now)))
            }
            CloudSync.get()?.recordSession(sessionId = entry.id, words = entry.wordCount, speechMs = entry.speechMs)
        } else {
            showError(error, run)
        }
    }

    /** @return null on success, or a user-facing error message. */
    private fun copyToClipboard(context: Context, text: String): String? = try {
        val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        clipboard.setPrimaryClip(ClipData.newPlainText("Murmur", text))
        null
    } catch (e: Exception) {
        Log.w(TAG, "clipboard write failed", e)
        "Could not copy the text"
    }

    /**
     * A dictation that produced nothing still shows up in History, with what went wrong. Before the
     * router resolved a connection (it may be what failed), the entry names the model the settings
     * would have used.
     */
    private fun recordFailure(
        context: Context,
        s: MurmurSettings,
        run: Run,
        raw: String,
        error: String,
        timings: StageTimings = StageTimings(recordMs = run.recordMs),
        provider: String = configuredProvider(context, s),
        model: String = configuredModel(context, s)
    ) {
        val now = System.currentTimeMillis()
        val previous = run.previous
        val entry = HistoryEntry(
            id = run.id.ifEmpty { UUID.randomUUID().toString() },
            createdAt = previous?.createdAt ?: now,
            rawText = raw.ifEmpty { previous?.rawText ?: "" },
            finalText = "",
            wordCount = 0,
            speechMs = timings.recordMs,
            appName = if (run.insert) appLabel(context, sink?.focusedPackage() ?: "") else previous?.appName,
            provider = provider,
            model = model,
            injected = false,
            llmUsed = false,
            timings = timings.copy(totalMs = (now - stoppedAt).coerceAtLeast(0)),
            error = error,
            recording = run.recording,
            attempts = run.attempts
        )
        val history = HistoryStore.get(context)
        if (previous != null) history.replace(entry) else history.add(entry)
    }

    private fun murmurSpeech(context: Context): Boolean =
        InferenceRouter.get(context).routing().stt == InferenceSource.MURMUR

    private fun configuredProvider(context: Context, s: MurmurSettings): String =
        if (murmurSpeech(context)) Inference.PROVIDER else s.sttKind.id

    private fun configuredModel(context: Context, s: MurmurSettings): String =
        if (murmurSpeech(context)) Inference.STT_MODEL else modelName(s)

    private fun modelName(s: MurmurSettings): String = s.sttModel.ifBlank {
        when (s.sttKind) {
            SttKind.DEEPGRAM -> "nova-3"
            SttKind.ELEVENLABS -> "scribe_v1"
            SttKind.OPENAI_COMPATIBLE -> ""
        }
    }

    /** The launcher label of the app that owned the field, when the system will tell us. */
    private fun appLabel(context: Context, packageName: String): String? {
        if (packageName.isBlank() || packageName == context.packageName) return null
        return try {
            val pm = context.packageManager
            pm.getApplicationLabel(pm.getApplicationInfo(packageName, 0)).toString()
        } catch (_: Exception) {
            packageName.substringAfterLast('.').replaceFirstChar { it.uppercase() }
        }
    }

    private fun showTransient(state: DictationState, holdMs: Long = 2500) {
        _state.value = state
        resetJob?.cancel()
        resetJob = scope.launch {
            delay(holdMs)
            _state.value = DictationState.Idle
        }
    }

    /**
     * A failure the user can do something about: when the audio was stored the pill offers to send
     * it again and waits much longer for the answer than a plain message would. A plan limit is
     * explained on the pill, with the ways forward, and waits longer still.
     */
    private fun showError(message: String, run: Run, limit: LimitNotice? = null) {
        val retryId = run.id.takeIf { run.recording != null }
        val hold = when {
            limit != null -> LIMIT_HOLD_MS
            retryId != null -> RETRY_HOLD_MS
            else -> 2500L
        }
        showTransient(DictationState.Error(message, retryId, limit), hold)
    }

    /** The plan limit behind an error, when a Murmur instance refused (or paused) on one. */
    fun planLimitOf(err: Throwable): LimitNotice? = (err as? SttException)?.planLimit

    private fun loadFixture(context: Context): ShortArray {
        val bytes = context.assets.open("fixtures/jfk.wav").use { it.readBytes() }
        val (pcm, rate) = Wav.decodePcm16(bytes)
        return Wav.resample(pcm, rate, SAMPLE_RATE)
    }

    fun friendlyError(err: Throwable): String = when {
        err is SttException -> err.friendly()
        err is SecurityException -> "Microphone permission missing — grant it in Murmur"
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.S &&
            err is android.app.ForegroundServiceStartNotAllowedException ->
            "Android blocked background recording — open Murmur once and try again"
        else -> err.message ?: "Something went wrong"
    }
}
