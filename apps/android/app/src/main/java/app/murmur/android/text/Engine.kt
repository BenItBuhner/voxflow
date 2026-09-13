package app.murmur.android.text

import app.murmur.android.inference.LimitNotice
import app.murmur.android.llm.ChatMessage
import app.murmur.android.settings.DictionaryEntry
import app.murmur.android.settings.FormattingMode
import org.json.JSONArray
import org.json.JSONObject

/**
 * Port of packages/text-engine/src/format.ts: raw transcript in, text to insert out. `complete`
 * is one chat completion; the engine decides whether to call it, what to send, whether to believe
 * the answer, and what to insert otherwise. Never throws: every failure degrades to the
 * rule-based cleanup with a status that says why. Against a Murmur instance the same work runs on
 * the gateway (`POST /v1/format`) and [FormatResult.fromJson] reads its answer.
 */

enum class FormatOutcome(val id: String) {
    USED("used"), SKIPPED("skipped"), REJECTED("rejected"), FAILED("failed");

    companion object {
        fun from(id: String?): FormatOutcome = entries.firstOrNull { it.id == id } ?: FAILED
    }
}

data class FormatStatus(
    val outcome: FormatOutcome,
    val detail: String? = null,
    val attempts: Int = 0,
    val retriedAfter: String? = null
)

data class FormatResult(
    val text: String,
    val pressEnter: Boolean,
    val status: FormatStatus,
    val modelText: String? = null,
    val llmMs: Long = 0,
    val stages: List<String> = emptyList(),
    /**
     * The plan limit a Murmur instance applied when it answered with rule-based text instead of
     * asking the model (a Pro account past its fair-use cap). Only ever set on a gateway answer.
     */
    val limit: LimitNotice? = null
) {
    companion object {
        /** The body of a `POST /v1/format` answer. */
        fun fromJson(json: JSONObject): FormatResult {
            val status = json.optJSONObject("status") ?: JSONObject()
            val stages = ArrayList<String>()
            json.optJSONArray("stages")?.let { arr -> for (i in 0 until arr.length()) stages.add(arr.optString(i)) }
            return FormatResult(
                text = json.optString("text", ""),
                pressEnter = json.optBoolean("pressEnter", false),
                status = FormatStatus(
                    outcome = FormatOutcome.from(status.optString("outcome")),
                    detail = status.optString("detail").takeIf { status.has("detail") && !status.isNull("detail") },
                    attempts = status.optInt("attempts", 0),
                    retriedAfter = status.optString("retriedAfter").takeIf { status.has("retriedAfter") && !status.isNull("retriedAfter") }
                ),
                modelText = json.optString("modelText").takeIf { json.has("modelText") && !json.isNull("modelText") },
                llmMs = json.optLong("llmMs", 0),
                stages = stages,
                limit = LimitNotice.fromJson(json.optJSONObject("limit"), status.optString("detail").takeIf { status.has("detail") })
            )
        }
    }
}

data class ModelAnswer(val text: String, val finishReason: String? = null)

/** One chat completion; injected so the engine never knows about HTTP, tokens or timeouts. */
typealias Complete = suspend (messages: List<ChatMessage>, maxTokens: Int) -> ModelAnswer

data class FormatInput(
    val transcript: String,
    val mode: FormattingMode,
    val context: FormatContext,
    val dictionary: List<DictionaryEntry>,
    val minWords: Int = 3,
    val retry: Boolean = true
) {
    /** The body of a `POST /v1/format` request. */
    fun toJson(): JSONObject = JSONObject().put("transcript", transcript).put("context", context.toJson())
}

object Engine {
    suspend fun formatTranscript(input: FormatInput, complete: Complete?): FormatResult {
        val prepared = prepareTranscript(input.transcript)

        fun fallback(
            outcome: FormatOutcome,
            detail: String?,
            attempts: Int = 0,
            retriedAfter: String? = null,
            llmMs: Long = 0,
            modelText: String? = null
        ): FormatResult {
            if (input.mode == FormattingMode.OFF) {
                return FormatResult(prepared.text, prepared.pressEnter, FormatStatus(outcome, detail, attempts, retriedAfter), modelText, llmMs, prepared.stages)
            }
            val light = basicCleanup(prepared.text, input.dictionary)
            return FormatResult(
                light.text, prepared.pressEnter, FormatStatus(outcome, detail, attempts, retriedAfter), modelText, llmMs,
                prepared.stages + light.stages
            )
        }

        if (input.mode != FormattingMode.SMART) {
            return fallback(FormatOutcome.SKIPPED, if (input.mode == FormattingMode.OFF) "formatting off" else "light mode")
        }
        if (!isMeaningful(prepared.text)) return fallback(FormatOutcome.SKIPPED, "nothing to format")
        if (complete == null) return fallback(FormatOutcome.SKIPPED, "no model configured")
        if (countWords(prepared.text) < input.minWords) return fallback(FormatOutcome.SKIPPED, "shorter than ${input.minWords} words")

        val started = System.currentTimeMillis()
        var attempts = 0
        var firstReason: String? = null
        var lastModelText: String? = null
        val maxAttempts = if (input.retry) 2 else 1

        for (attempt in 0 until maxAttempts) {
            attempts++
            val answer = try {
                complete(Prompt.buildFormatMessages(prepared.text, input.context, strict = attempt > 0), Prompt.maxTokensFor(prepared.text))
            } catch (e: Exception) {
                return fallback(FormatOutcome.FAILED, e.message ?: e.toString(), attempts, firstReason, System.currentTimeMillis() - started, lastModelText)
            }
            val text = Verify.cleanModelOutput(answer.text, prepared.text)
            lastModelText = text
            val verdict = if (answer.finishReason == "length") Verify.Verdict(false, "too-long")
            else Verify.verifyOutput(prepared.text, text, language = input.context.language, keepVerbatim = input.context.keepVerbatim)
            if (verdict.ok) {
                return FormatResult(
                    text = text,
                    pressEnter = prepared.pressEnter,
                    status = FormatStatus(FormatOutcome.USED, null, attempts, firstReason),
                    modelText = text,
                    llmMs = System.currentTimeMillis() - started,
                    stages = prepared.stages + (if (attempt > 0) "llm-strict" else "llm")
                )
            }
            val detail = when (verdict.reason) {
                "numbers-changed" -> "numbers-changed (${verdict.expected} -> ${verdict.actual})"
                "verbatim-lost" -> "verbatim-lost (${verdict.expected})"
                else -> verdict.reason ?: "rejected"
            }
            if (attempt == 0) firstReason = detail
            else return fallback(FormatOutcome.REJECTED, detail, attempts, firstReason, System.currentTimeMillis() - started, text)
        }
        return fallback(FormatOutcome.REJECTED, firstReason, attempts, null, System.currentTimeMillis() - started, lastModelText)
    }
}

/** Helper for tests and the router: a JSON array of chat messages, as sent to a provider. */
fun List<ChatMessage>.toJsonArray(): JSONArray = JSONArray().apply {
    for (m in this@toJsonArray) put(JSONObject().put("role", m.role).put("content", m.content))
}
