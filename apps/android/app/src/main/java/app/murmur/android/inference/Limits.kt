package app.murmur.android.inference

import app.murmur.android.cloud.InferenceStatusDto
import app.murmur.android.cloud.UsageMeterDto
import app.murmur.android.cloud.UserDto
import org.json.JSONObject
import java.util.Calendar
import java.util.Locale
import kotlin.math.ceil
import kotlin.math.roundToInt

/**
 * The structured part of a gateway refusal (HTTP 429/413 with `error.limit`), or of the `limit`
 * object `/v1/format` attaches when it skipped the model for fair use. The pill renders these
 * rather than the sentence alone, so the user learns which limit it was and when it comes back.
 * Port of apps/desktop/src/shared/limits.ts; field names follow the entitlements contract.
 */
data class LimitNotice(
    val limit: String,
    val plan: String,
    val planState: String,
    val used: Double,
    val allowed: Double,
    /** Epoch ms when the limit next lets a request through; null for a per-request limit. */
    val resetsAt: Long?,
    /** The web account page that starts an upgrade; null when already Pro or the instance has no site. */
    val upgradeUrl: String?,
    /** The gateway's own sentence. */
    val message: String
) {
    /** A limit that stops a dictation for plan reasons; a rate limit is a plain "try again in a moment". */
    val isPlanLimit: Boolean get() = Limits.isPlanLimit(limit)

    companion object {
        /**
         * Read a notice out of an object carrying the contract's fields (a gateway `error` object or
         * a `/v1/format` `limit` object). Null when there is no known `limit` in it.
         */
        fun fromJson(source: JSONObject?, message: String? = null): LimitNotice? {
            if (source == null) return null
            val limit = source.optString("limit", "")
            if (limit !in Limits.NAMES) return null
            val plan = if (source.optString("plan") == "pro") "pro" else "free"
            val planState = source.optString("planState").takeIf { it in Limits.PLAN_STATES } ?: plan
            return LimitNotice(
                limit = limit,
                plan = plan,
                planState = planState,
                used = source.optDouble("used", 0.0).takeIf { it.isFinite() } ?: 0.0,
                allowed = source.optDouble("allowed", 0.0).takeIf { it.isFinite() } ?: 0.0,
                resetsAt = if (source.isNull("resetsAt") || !source.has("resetsAt")) null else source.optDouble("resetsAt").takeIf { it.isFinite() }?.toLong(),
                upgradeUrl = source.optString("upgradeUrl", "").takeIf { !source.isNull("upgradeUrl") && it.isNotEmpty() },
                message = message ?: source.optString("message", "")
            )
        }
    }
}

/** How a limit is worded: what ran out, the allowance and its reset, whether upgrading helps. */
data class LimitCopy(val title: String, val detail: String, val upgradeHelps: Boolean)

/** What the limit stopped: a formatting limit never loses text (rules are applied instead). */
enum class LimitStage { SPEECH, FORMATTING }

object Limits {
    val NAMES = setOf(
        "wordsPerWeek", "sttSecondsPerWeek", "dictationsPerDay", "maxClipSeconds",
        "sttSecondsPerMonth", "fairUseSttSecondsPerMonth", "llmTokensPerMonth", "requestsPerMinute"
    )
    val PLAN_STATES = setOf("trial", "free", "pro")

    private const val MINUTE = 60_000L
    private const val HOUR = 3_600_000L
    private const val DAY = 86_400_000L
    private val WEEKDAYS = listOf("Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat")
    private val MONTHS = listOf("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")

    fun isPlanLimit(limit: String): Boolean = limit != "requestsPerMinute"

    fun planStateLabel(state: String): String = when (state) {
        "trial" -> "Pro trial"
        "pro" -> "Pro"
        else -> "Free"
    }

    /** "Pro trial", "Free plan", "Pro plan": the plan as a title. */
    fun planTitle(state: String): String = if (state == "trial") "Pro trial" else "${planStateLabel(state)} plan"

    /** The account's plan state, from an instance that reports one or, failing that, from its tier. */
    fun planStateOf(status: InferenceStatusDto?, user: UserDto?): String {
        status?.planState?.takeIf { it in PLAN_STATES }?.let { return it }
        user?.planState?.takeIf { it in PLAN_STATES }?.let { return it }
        val plan = status?.plan ?: user?.plan ?: "free"
        return if (plan == "pro") "pro" else "free"
    }

    /** Whole days left on the trial, never negative: `ceil((trialEndsAt - now) / 24 h)`. */
    fun trialDaysLeft(trialEndsAt: Double?, now: Long = System.currentTimeMillis()): Int {
        if (trialEndsAt == null || !trialEndsAt.isFinite()) return 0
        return ceil((trialEndsAt - now) / DAY).toInt().coerceAtLeast(0)
    }

    private fun clockTime(cal: Calendar): String {
        val h = cal.get(Calendar.HOUR_OF_DAY)
        val hour = if (h % 12 == 0) 12 else h % 12
        return "%d:%02d %s".format(Locale.US, hour, cal.get(Calendar.MINUTE), if (h < 12) "am" else "pm")
    }

    private fun sameLocalDay(a: Calendar, b: Calendar): Boolean =
        a.get(Calendar.YEAR) == b.get(Calendar.YEAR) && a.get(Calendar.DAY_OF_YEAR) == b.get(Calendar.DAY_OF_YEAR)

    /**
     * When a limit comes back, the way a person would say it: "in 40 min", "at 3:00 pm",
     * "tomorrow at 1:00 am", "Tue 16 Sep", "on 25 Sep". Local time.
     */
    fun formatResetTime(resetsAt: Long, now: Long = System.currentTimeMillis()): String {
        val diff = resetsAt - now
        if (diff < MINUTE) return "in a moment"
        if (diff < HOUR) return "in ${ceil(diff / MINUTE.toDouble()).toInt()} min"
        val then = Calendar.getInstance().apply { timeInMillis = resetsAt }
        val today = Calendar.getInstance().apply { timeInMillis = now }
        if (sameLocalDay(then, today)) return "at ${clockTime(then)}"
        val tomorrow = Calendar.getInstance().apply { timeInMillis = now + DAY }
        if (sameLocalDay(then, tomorrow)) return "tomorrow at ${clockTime(then)}"
        val date = "${then.get(Calendar.DAY_OF_MONTH)} ${MONTHS[then.get(Calendar.MONTH)]}"
        return if (diff < 6 * DAY) "${WEEKDAYS[then.get(Calendar.DAY_OF_WEEK) - 1]} $date" else "on $date"
    }

    fun formatCount(n: Double): String = "%,d".format(Locale.US, n.roundToInt())

    /** Token counts read in thousands and millions: "12k", "500k", "2.1M", "25M". */
    fun compactCount(n: Double): String = when {
        n >= 1_000_000 -> {
            val m = n / 1_000_000
            if (m >= 10 || m == Math.floor(m)) "${m.roundToInt()}M" else "%.1fM".format(Locale.US, m)
        }
        n >= 10_000 -> "${(n / 1000).roundToInt()}k"
        else -> formatCount(n)
    }

    private fun audioFigure(seconds: Double, allowedSeconds: Double): Pair<String, String> {
        val hours = allowedSeconds >= 3 * 3600 && allowedSeconds % 3600.0 == 0.0
        if (hours) {
            val h = seconds / 3600
            val value = if (h >= 10 || h == Math.floor(h)) h.roundToInt().toString() else "%.1f".format(Locale.US, h)
            return value to "h"
        }
        val m = seconds / 60
        return (if (m > 0 && m < 1) "<1" else m.roundToInt().toString()) to "min"
    }

    /** "7 min", "120 min", "30 h"; [allowedSeconds] decides the unit when a used figure is shown against it. */
    fun formatAudioSeconds(seconds: Double, allowedSeconds: Double = seconds): String {
        val (value, unit) = audioFigure(seconds, allowedSeconds)
        return "$value $unit"
    }

    /** "312 of 500 words", "12 of 120 min", "2.5 of 30 h", "3 of 12". */
    fun meterValue(limit: String, used: Double, allowed: Double): String = when (limit) {
        "wordsPerWeek" -> "${formatCount(used)} of ${formatCount(allowed)} words"
        "sttSecondsPerWeek", "sttSecondsPerMonth", "fairUseSttSecondsPerMonth" ->
            "${audioFigure(used, allowed).first} of ${formatAudioSeconds(allowed)}"
        "llmTokensPerMonth" -> "${compactCount(used)} of ${compactCount(allowed)} tokens"
        "maxClipSeconds" -> "up to ${formatAudioSeconds(allowed)} a clip"
        else -> "${formatCount(used)} of ${formatCount(allowed)}"
    }

    fun meterValue(meter: UsageMeterDto): String = meterValue(meter.limit, meter.used, meter.allowed)

    /** The Account screen's label for a meter. */
    fun meterLabel(limit: String): String = when (limit) {
        "wordsPerWeek" -> "Words this week"
        "sttSecondsPerWeek" -> "Speech this week"
        "dictationsPerDay" -> "Dictations today"
        "sttSecondsPerMonth" -> "Transcription this month"
        "fairUseSttSecondsPerMonth" -> "Fair use this month"
        "llmTokensPerMonth" -> "Formatting this month"
        "maxClipSeconds" -> "Recording length"
        else -> "Requests this minute"
    }

    /** Meters worth a row on the Account screen: the ones that fill up over time. */
    fun usageMeters(meters: List<UsageMeterDto>): List<UsageMeterDto> =
        meters.filter { it.limit in NAMES && it.limit != "maxClipSeconds" && it.limit != "requestsPerMinute" }

    /**
     * The calm version of a refusal: which limit it was, the allowance, and when it resets. A
     * formatting limit never loses text (the rule-based cleanup is inserted instead), and the
     * wording says so.
     */
    fun describe(notice: LimitNotice, now: Long = System.currentTimeMillis(), stage: LimitStage = LimitStage.SPEECH): LimitCopy {
        val reset = notice.resetsAt?.let { formatResetTime(it, now) }
        val resets = if (reset != null) " · resets $reset" else ""
        val pro = notice.plan == "pro"
        val tier = if (pro) "on Pro" else "on the free plan"
        val unformatted = stage == LimitStage.FORMATTING
        return when (notice.limit) {
            "wordsPerWeek" -> LimitCopy(
                "This week's free words are used up",
                "${formatCount(notice.allowed)} words a week $tier$resets",
                true
            )
            "sttSecondsPerWeek" -> LimitCopy(
                "This week's free minutes are used up",
                "${formatAudioSeconds(notice.allowed)} of speech a week $tier$resets",
                true
            )
            "dictationsPerDay" -> LimitCopy(
                if (unformatted) "Inserted without formatting: today's free dictations are used up" else "Today's free dictations are used up",
                "${formatCount(notice.allowed)} dictations a day $tier$resets",
                true
            )
            "maxClipSeconds" -> LimitCopy(
                if (pro) "That recording is too long" else "That recording is too long for the free plan",
                if (pro) "Clips can be up to ${formatAudioSeconds(notice.allowed)}"
                else "Clips up to ${formatAudioSeconds(notice.allowed)} $tier; up to 10 min on Pro",
                !pro
            )
            "sttSecondsPerMonth" -> LimitCopy(
                if (pro) "This month's transcription has reached its fair-use cap" else "This month's free transcription is used up",
                "${formatAudioSeconds(notice.allowed)} a month $tier$resets",
                !pro
            )
            "fairUseSttSecondsPerMonth" -> LimitCopy(
                "Inserted without formatting: fair use reached for this month",
                "Past ${formatAudioSeconds(notice.allowed)} of transcription a month the text is tidied by rules only$resets",
                false
            )
            "llmTokensPerMonth" -> LimitCopy(
                if (unformatted) "Inserted without formatting: this month's formatting allowance is used up" else "This month's formatting allowance is used up",
                "${compactCount(notice.allowed)} tokens a month $tier$resets",
                !pro
            )
            else -> LimitCopy(
                "Too many requests at once",
                "Up to ${formatCount(notice.allowed)} requests a minute $tier$resets",
                !pro
            )
        }
    }
}
