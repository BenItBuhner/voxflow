package app.murmur.android.stt

import app.murmur.android.inference.Inference
import app.murmur.android.inference.LimitNotice
import app.murmur.android.settings.SttKind
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.IOException
import java.io.InterruptedIOException
import java.net.URLEncoder
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit

// ---- error model: port of apps/desktop/src/core/stt/types.ts --------------------------------

enum class SttErrorKind { AUTH, MODEL, RATE_LIMIT, SERVER, NETWORK, TIMEOUT, BAD_REQUEST, UNKNOWN }

class SttException(
    message: String,
    val kind: SttErrorKind,
    val status: Int? = null,
    val suggestedModels: List<String> = emptyList(),
    /** Machine-readable `error.code` from the server, when it sent one (the Murmur gateway does). */
    val code: String? = null,
    /** The plan limit a Murmur instance refused the request on, when that is what happened. */
    val limit: LimitNotice? = null
) : Exception(message) {
    /** The plan limit behind this error, or null for anything else (including a plain rate limit). */
    val planLimit: LimitNotice? get() = limit?.takeIf { it.isPlanLimit }
    val retryable: Boolean
        get() = kind == SttErrorKind.SERVER || kind == SttErrorKind.MODEL ||
            kind == SttErrorKind.RATE_LIMIT || kind == SttErrorKind.TIMEOUT

    fun friendly(): String {
        // The Murmur gateway (and the router in front of it) already speak to the user.
        if (code != null && code in Inference.ERROR_CODES) return message ?: "Something went wrong"
        return when (kind) {
            SttErrorKind.AUTH -> "Authentication failed — check your API key"
            SttErrorKind.MODEL ->
                if (suggestedModels.isNotEmpty())
                    "Model not available. Try: ${suggestedModels.take(3).joinToString(", ")}"
                else "Model not available: $message"
            SttErrorKind.RATE_LIMIT -> "Rate limited by the provider — try again in a moment"
            SttErrorKind.TIMEOUT -> "The server took too long to respond"
            SttErrorKind.SERVER -> "Provider error: $message"
            else -> message ?: "Something went wrong"
        }
    }
}

fun normalizeBaseUrl(url: String): String = url.trim().trimEnd('/')

/** What an OpenAI-style error body said. Destructures as `(message, suggestedModels)` too. */
data class ParsedError(
    val message: String,
    val suggestedModels: List<String>,
    val code: String? = null,
    /** The Murmur gateway's structured limit, when the body carries one. */
    val limit: LimitNotice? = null
)

/**
 * Pull a human-readable message, an error code, any "available models" hint and the Murmur
 * gateway's structured limit out of an error body.
 */
fun parseErrorBody(body: String): ParsedError {
    var message = body.trim().take(500)
    var code: String? = null
    var limit: LimitNotice? = null
    try {
        val json = JSONObject(body)
        when {
            json.opt("error") is String -> message = json.getString("error")
            json.optJSONObject("error")?.has("message") == true ->
                message = json.getJSONObject("error").getString("message")
            json.opt("message") is String -> message = json.getString("message")
            json.opt("detail") is String -> message = json.getString("detail")
        }
        json.optJSONObject("error")?.let { error ->
            error.opt("code")?.let { if (it is String) code = it }
            limit = LimitNotice.fromJson(error, message)
        }
    } catch (_: Exception) {
        // not JSON
    }
    val suggested = ArrayList<String>()
    val m = Regex("available (?:audio )?models?:\\s*([^.\\n]+)", RegexOption.IGNORE_CASE).find(message)
    if (m != null) {
        for (part in m.groupValues[1].split(',', ';')) {
            val id = part.trim().trim('\'', '"', '`')
            if (id.isNotEmpty()) suggested.add(id)
        }
    }
    return ParsedError(message, suggested, code, limit)
}

/** Build the exception for a non-2xx response from an OpenAI-style server. */
fun errorFromResponse(status: Int, body: String): SttException {
    val (message, suggested, code, limit) = parseErrorBody(body)
    return SttException(message.ifEmpty { "HTTP $status" }, classifyStatus(status, message), status, suggested, code, limit)
}

fun classifyStatus(status: Int, message: String): SttErrorKind = when {
    status == 401 || status == 403 -> SttErrorKind.AUTH
    status == 429 -> SttErrorKind.RATE_LIMIT
    status == 404 || Regex("model", RegexOption.IGNORE_CASE).containsMatchIn(message) -> SttErrorKind.MODEL
    status >= 500 -> SttErrorKind.SERVER
    status >= 400 -> SttErrorKind.BAD_REQUEST
    else -> SttErrorKind.UNKNOWN
}

fun toSttException(err: Throwable, fallback: String = "Transcription failed"): SttException = when {
    err is SttException -> err
    err is InterruptedIOException -> SttException("Request timed out", SttErrorKind.TIMEOUT)
    err is IOException -> SttException("Cannot reach the server (${err.message ?: "network error"})", SttErrorKind.NETWORK)
    else -> SttException(err.message ?: fallback, SttErrorKind.UNKNOWN)
}

/** Rank model ids so speech models float to the top of pickers. */
fun rankSpeechModels(ids: List<String>): List<String> {
    fun score(id: String): Int {
        val s = id.lowercase()
        if (Regex("whisper|stt|transcri|speech|scribe|voxtral|nova|audio").containsMatchIn(s)) return 0
        if (Regex("tts|embed|image|vision|rerank|moderation").containsMatchIn(s)) return 2
        return 1
    }
    return ids.distinct().sortedWith(compareBy({ score(it) }, { it }))
}

// ---- transcription --------------------------------------------------------------------------

data class SttConfig(
    val kind: SttKind,
    val baseUrl: String,
    val apiKey: String,
    val model: String,
    val language: String,
    val timeoutMs: Int
)

/** A timed span of the transcript, in seconds from the start of the audio that was sent. */
data class TimedSpan(val start: Double, val end: Double)

data class TranscribeOutput(
    val text: String,
    val language: String? = null,
    val durationSec: Double? = null,
    val noSpeechProb: Double? = null,
    val latencyMs: Long,
    /**
     * Where in the audio the transcript's words sit: word-level timings when the provider offers
     * them, otherwise segment-level. Lets the caller notice a transcript that stopped before the
     * speech did and resume from that point.
     */
    val spans: List<TimedSpan>? = null
)

/**
 * Timed spans from a verbose_json body. Word timings win: they come from alignment and stay right
 * even when the decoder stopped early, whereas a segment that was never closed with a timestamp is
 * reported as running to the end of its 30-second window.
 */
fun spansFromVerbose(json: JSONObject): List<TimedSpan>? {
    fun read(array: org.json.JSONArray?): List<TimedSpan> {
        if (array == null) return emptyList()
        val out = ArrayList<TimedSpan>()
        for (i in 0 until array.length()) {
            val o = array.optJSONObject(i) ?: continue
            if (!o.has("start") || !o.has("end")) continue
            val start = o.optDouble("start")
            val end = o.optDouble("end")
            if (start.isNaN() || end.isNaN() || end < 0) continue
            out.add(TimedSpan(start, end))
        }
        return out
    }
    val words = read(json.optJSONArray("words"))
    if (words.isNotEmpty()) return words
    val segments = read(json.optJSONArray("segments"))
    return segments.ifEmpty { null }
}

object SttClient {
    private val baseClient = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .build()

    /** Servers that rejected verbose_json once are remembered, like the desktop client. */
    private val verboseUnsupported = ConcurrentHashMap.newKeySet<String>()
    /** Servers that rejected word-level timestamps; they still get verbose_json for segment timings. */
    private val wordTimestampsUnsupported = ConcurrentHashMap.newKeySet<String>()

    private fun client(timeoutMs: Int): OkHttpClient = baseClient.newBuilder()
        .callTimeout(timeoutMs.toLong().coerceAtLeast(1000), TimeUnit.MILLISECONDS)
        .readTimeout(timeoutMs.toLong().coerceAtLeast(1000), TimeUnit.MILLISECONDS)
        .build()

    suspend fun transcribe(wav: ByteArray, prompt: String?, cfg: SttConfig): TranscribeOutput =
        withContext(Dispatchers.IO) {
            try {
                when (cfg.kind) {
                    SttKind.OPENAI_COMPATIBLE -> transcribeOpenAi(wav, prompt, cfg)
                    SttKind.DEEPGRAM -> transcribeDeepgram(wav, cfg)
                    SttKind.ELEVENLABS -> transcribeElevenLabs(wav, cfg)
                }
            } catch (e: Exception) {
                throw toSttException(e)
            }
        }

    /** Same fallback-model retry policy as the desktop session orchestrator. */
    suspend fun transcribeWithFallback(
        wav: ByteArray,
        prompt: String?,
        cfg: SttConfig,
        fallbackModel: String
    ): TranscribeOutput = try {
        transcribe(wav, prompt, cfg)
    } catch (e: SttException) {
        if (e.retryable && fallbackModel.isNotEmpty() && fallbackModel != cfg.model) {
            transcribe(wav, prompt, cfg.copy(model = fallbackModel))
        } else throw e
    }

    private fun transcribeOpenAi(wav: ByteArray, prompt: String?, cfg: SttConfig): TranscribeOutput {
        val base = normalizeBaseUrl(cfg.baseUrl)
        if (base.isEmpty()) throw SttException("No STT base URL configured", SttErrorKind.BAD_REQUEST)
        if (cfg.model.isEmpty()) throw SttException("No STT model selected", SttErrorKind.MODEL)
        val url = "$base/audio/transcriptions"
        val wantVerbose = base !in verboseUnsupported
        val started = System.nanoTime()

        fun attempt(verbose: Boolean, wordTimestamps: Boolean): okhttp3.Response {
            val form = MultipartBody.Builder().setType(MultipartBody.FORM)
                .addFormDataPart("file", "audio.wav", wav.toRequestBody("audio/wav".toMediaType()))
                .addFormDataPart("model", cfg.model)
                .addFormDataPart("response_format", if (verbose) "verbose_json" else "json")
                .addFormDataPart("temperature", "0")
            if (verbose && wordTimestamps) {
                form.addFormDataPart("timestamp_granularities[]", "word")
                form.addFormDataPart("timestamp_granularities[]", "segment")
            }
            if (cfg.language.isNotEmpty() && cfg.language != "auto") form.addFormDataPart("language", cfg.language)
            if (!prompt.isNullOrEmpty()) form.addFormDataPart("prompt", prompt)
            val req = Request.Builder().url(url).post(form.build()).apply {
                if (cfg.apiKey.isNotEmpty()) header("Authorization", "Bearer ${cfg.apiKey}")
            }.build()
            return client(cfg.timeoutMs).newCall(req).execute()
        }

        val verboseRejected = Regex("response_format|verbose", RegexOption.IGNORE_CASE)
        val granularityRejected = Regex("timestamp_granularities|granularit", RegexOption.IGNORE_CASE)
        val wantWords = wantVerbose && base !in wordTimestampsUnsupported
        var res = attempt(wantVerbose, wantWords)
        if (!res.isSuccessful && res.code == 400 && wantWords) {
            // Word timestamps are the newest thing we ask for, so they are the first suspect for a
            // rejected request: try once without them before judging the error. A server that names
            // the field is remembered so the extra round-trip is not paid again.
            val body = res.body?.string() ?: ""
            res.close()
            if (granularityRejected.containsMatchIn(body)) wordTimestampsUnsupported.add(base)
            res = attempt(true, false)
        }
        if (!res.isSuccessful && wantVerbose && res.code == 400) {
            val body = res.body?.string() ?: ""
            res.close()
            if (verboseRejected.containsMatchIn(body)) {
                verboseUnsupported.add(base)
                res = attempt(false, false)
            } else {
                throw errorFromResponse(400, body)
            }
        }
        res.use { r ->
            if (!r.isSuccessful) throw errorFromResponse(r.code, r.body?.string() ?: "")
            val contentType = r.header("content-type") ?: ""
            val bodyText = r.body?.string() ?: ""
            var text = bodyText
            var language: String? = null
            var duration: Double? = null
            var noSpeech: Double? = null
            var spans: List<TimedSpan>? = null
            if (contentType.contains("json")) {
                val json = JSONObject(bodyText)
                text = json.optString("text", "")
                language = json.optString("language").takeIf { it.isNotEmpty() }
                duration = if (json.has("duration")) json.optDouble("duration") else null
                val segments = json.optJSONArray("segments")
                if (segments != null && segments.length() > 0) {
                    var acc = 0.0
                    for (i in 0 until segments.length())
                        acc += segments.getJSONObject(i).optDouble("no_speech_prob", 0.0)
                    noSpeech = acc / segments.length()
                }
                spans = spansFromVerbose(json)
            }
            return TranscribeOutput(
                text = text.trim(),
                language = language,
                durationSec = duration,
                noSpeechProb = noSpeech,
                latencyMs = (System.nanoTime() - started) / 1_000_000,
                spans = spans
            )
        }
    }

    private fun transcribeDeepgram(wav: ByteArray, cfg: SttConfig): TranscribeOutput {
        val base = normalizeBaseUrl(cfg.baseUrl.ifEmpty { "https://api.deepgram.com/v1" })
        if (cfg.apiKey.isEmpty()) throw SttException("Deepgram requires an API key", SttErrorKind.AUTH)
        val params = StringBuilder("model=${enc(cfg.model.ifEmpty { "nova-3" })}&smart_format=true&punctuate=true")
        if (cfg.language.isNotEmpty() && cfg.language != "auto") params.append("&language=${enc(cfg.language)}")
        else params.append("&detect_language=true")
        val started = System.nanoTime()
        val req = Request.Builder()
            .url("$base/listen?$params")
            .header("Authorization", "Token ${cfg.apiKey}")
            .header("Content-Type", "audio/wav")
            .post(wav.toRequestBody("audio/wav".toMediaType()))
            .build()
        client(cfg.timeoutMs).newCall(req).execute().use { r ->
            if (!r.isSuccessful) {
                val (message, _) = parseErrorBody(r.body?.string() ?: "")
                throw SttException(message.ifEmpty { "HTTP ${r.code}" }, classifyStatus(r.code, message), r.code)
            }
            val json = JSONObject(r.body?.string() ?: "{}")
            val channel = json.optJSONObject("results")?.optJSONArray("channels")?.optJSONObject(0)
            val alternative = channel?.optJSONArray("alternatives")?.optJSONObject(0)
            val text = alternative?.optString("transcript") ?: ""
            val spans = alternative?.let { spansFromVerbose(JSONObject().put("words", it.optJSONArray("words"))) }
            return TranscribeOutput(
                text = text.trim(),
                language = channel?.optString("detected_language")?.takeIf { it.isNotEmpty() },
                durationSec = json.optJSONObject("metadata")?.optDouble("duration"),
                latencyMs = (System.nanoTime() - started) / 1_000_000,
                spans = spans
            )
        }
    }

    private fun transcribeElevenLabs(wav: ByteArray, cfg: SttConfig): TranscribeOutput {
        val base = normalizeBaseUrl(cfg.baseUrl.ifEmpty { "https://api.elevenlabs.io/v1" })
        if (cfg.apiKey.isEmpty()) throw SttException("ElevenLabs requires an API key", SttErrorKind.AUTH)
        val form = MultipartBody.Builder().setType(MultipartBody.FORM)
            .addFormDataPart("file", "audio.wav", wav.toRequestBody("audio/wav".toMediaType()))
            .addFormDataPart("model_id", cfg.model.ifEmpty { "scribe_v1" })
            .addFormDataPart("tag_audio_events", "false")
            .addFormDataPart("diarize", "false")
        if (cfg.language.isNotEmpty() && cfg.language != "auto") form.addFormDataPart("language_code", cfg.language)
        val started = System.nanoTime()
        val req = Request.Builder()
            .url("$base/speech-to-text")
            .header("xi-api-key", cfg.apiKey)
            .post(form.build())
            .build()
        client(cfg.timeoutMs).newCall(req).execute().use { r ->
            if (!r.isSuccessful) {
                val (message, _) = parseErrorBody(r.body?.string() ?: "")
                throw SttException(message.ifEmpty { "HTTP ${r.code}" }, classifyStatus(r.code, message), r.code)
            }
            val json = JSONObject(r.body?.string() ?: "{}")
            // Scribe lists words, spacing and audio events; only the words carry the transcript.
            val words = json.optJSONArray("words")?.let { all ->
                val onlyWords = org.json.JSONArray()
                for (i in 0 until all.length()) {
                    val w = all.optJSONObject(i) ?: continue
                    if (w.optString("type", "word") == "word") onlyWords.put(w)
                }
                JSONObject().put("words", onlyWords)
            }
            return TranscribeOutput(
                text = json.optString("text", "").trim(),
                language = json.optString("language_code").takeIf { it.isNotEmpty() },
                latencyMs = (System.nanoTime() - started) / 1_000_000,
                spans = words?.let { spansFromVerbose(it) }
            )
        }
    }

    suspend fun listModels(cfg: SttConfig): List<String> = withContext(Dispatchers.IO) {
        when (cfg.kind) {
            SttKind.ELEVENLABS -> listOf("scribe_v1", "scribe_v1_experimental")
            SttKind.DEEPGRAM -> listOf("nova-3", "nova-2", "nova-3-medical", "enhanced", "base")
            SttKind.OPENAI_COMPATIBLE -> {
                val base = normalizeBaseUrl(cfg.baseUrl)
                if (base.isEmpty()) throw SttException("No base URL configured", SttErrorKind.BAD_REQUEST)
                val req = Request.Builder().url("$base/models").apply {
                    if (cfg.apiKey.isNotEmpty()) header("Authorization", "Bearer ${cfg.apiKey}")
                }.build()
                try {
                    client(15_000).newCall(req).execute().use { r ->
                        if (!r.isSuccessful) throw errorFromResponse(r.code, r.body?.string() ?: "")
                        val json = JSONObject(r.body?.string() ?: "{}")
                        val ids = ArrayList<String>()
                        val data = json.optJSONArray("data")
                        if (data != null) for (i in 0 until data.length()) {
                            val id = data.optJSONObject(i)?.optString("id") ?: continue
                            if (id.isNotEmpty()) ids.add(id)
                        }
                        rankSpeechModels(ids)
                    }
                } catch (e: Exception) {
                    throw toSttException(e, "Could not list models")
                }
            }
        }
    }

    private fun enc(s: String): String = URLEncoder.encode(s, "UTF-8")
}
