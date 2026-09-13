package app.murmur.android

import app.murmur.android.cloud.InferenceStatusDto
import app.murmur.android.cloud.UsageMeterDto
import app.murmur.android.cloud.UserDto
import app.murmur.android.inference.InferenceRouting
import app.murmur.android.inference.LimitNotice
import app.murmur.android.inference.LimitStage
import app.murmur.android.inference.Limits
import app.murmur.android.inference.PlanActions
import app.murmur.android.settings.InferenceSource
import app.murmur.android.ui.InferenceView
import app.murmur.android.stt.SttErrorKind
import app.murmur.android.stt.errorFromResponse
import app.murmur.android.stt.parseErrorBody
import app.murmur.android.text.FormatOutcome
import app.murmur.android.text.FormatResult
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Calendar
import java.util.TimeZone

private const val UPGRADE = "https://murmur.app/account?upgrade=yearly"
private const val ACCOUNT = "https://murmur.app/account"

/** Sun 13 Sep 2026, noon UTC. */
private val NOW: Long = Calendar.getInstance(TimeZone.getTimeZone("UTC")).apply {
    clear()
    set(2026, Calendar.SEPTEMBER, 13, 12, 0, 0)
}.timeInMillis
private const val DAY = 86_400_000L

/** A gateway refusal, as the contract spells it (internal/entitlements-contract.md). */
private fun refusal(vararg overrides: Pair<String, Any?>): String {
    val error = JSONObject()
        .put("type", "murmur_gateway_error")
        .put("code", "quota_exceeded")
        .put("message", "This week's 500 free words are used up.")
        .put("limit", "wordsPerWeek")
        .put("plan", "free")
        .put("planState", "free")
        .put("used", 503)
        .put("allowed", 500)
        .put("resetsAt", NOW + 2 * DAY)
        .put("upgradeUrl", UPGRADE)
        .put("accountUrl", ACCOUNT)
    for ((k, v) in overrides) if (v == null) error.put(k, JSONObject.NULL) else error.put(k, v)
    return JSONObject().put("error", error).toString()
}

/** The limit notice and the wording built on it (port of shared/limits.ts and its tests). */
class LimitsTest {

    @Test
    fun `a refusal body yields a notice that travels on the exception`() {
        val parsed = parseErrorBody(refusal())
        assertEquals("quota_exceeded", parsed.code)
        assertEquals(
            LimitNotice("wordsPerWeek", "free", "free", 503.0, 500.0, NOW + 2 * DAY, UPGRADE, ACCOUNT, "This week's 500 free words are used up."),
            parsed.limit
        )
        val e = errorFromResponse(429, refusal())
        assertEquals(SttErrorKind.RATE_LIMIT, e.kind)
        assertEquals("wordsPerWeek", e.limit?.limit)
        assertEquals(e.message, e.limit?.message)
        assertNotNull(e.planLimit)
        assertEquals(e.message, e.friendly())

        // A clip refusal is a 413 with no reset and no upgrade for a Pro account.
        val clip = errorFromResponse(
            413,
            refusal("code" to "clip_too_long", "limit" to "maxClipSeconds", "plan" to "pro", "planState" to "pro", "used" to 640, "allowed" to 600, "resetsAt" to null, "upgradeUrl" to null)
        )
        assertEquals("maxClipSeconds", clip.limit?.limit)
        assertNull(clip.limit?.resetsAt)
        assertNull(clip.limit?.upgradeUrl)
        assertEquals(ACCOUNT, clip.limit?.accountUrl)
        // An instance without a site URL sends null for both pages.
        val siteless = errorFromResponse(429, refusal("upgradeUrl" to null, "accountUrl" to null))
        assertNull(siteless.limit?.upgradeUrl)
        assertNull(siteless.limit?.accountUrl)

        // A rate limit carries a notice but is not a plan limit: the ordinary error treatment.
        val rate = errorFromResponse(429, refusal("code" to "rate_limited", "limit" to "requestsPerMinute", "used" to 20, "allowed" to 20))
        assertEquals("requestsPerMinute", rate.limit?.limit)
        assertNull(rate.planLimit)
    }

    @Test
    fun `ordinary errors carry no notice`() {
        assertNull(parseErrorBody("""{"error":{"message":"boom","code":"upstream_error"}}""").limit)
        assertNull(parseErrorBody("not json").limit)
        assertNull(LimitNotice.fromJson(JSONObject().put("limit", "somethingElse")))
        assertNull(LimitNotice.fromJson(null))
        // Missing details default sensibly; the tier falls back to the plan.
        assertEquals(
            LimitNotice("dictationsPerDay", "pro", "pro", 0.0, 0.0, null, null, null, ""),
            LimitNotice.fromJson(JSONObject().put("limit", "dictationsPerDay").put("plan", "pro"))
        )
    }

    @Test
    fun `a format answer skipped for fair use carries the limit that paused the model`() {
        val body = JSONObject(
            """{"text":"Hello there","pressEnter":false,"status":{"outcome":"skipped","detail":"fair use"},"llmMs":0,"stages":[],
               "limit":{"limit":"fairUseSttSecondsPerMonth","plan":"pro","planState":"pro","used":108500,"allowed":108000,"resetsAt":${NOW + 10 * DAY},"upgradeUrl":null}}"""
        )
        val result = FormatResult.fromJson(body)
        assertEquals(FormatOutcome.SKIPPED, result.status.outcome)
        assertEquals("fairUseSttSecondsPerMonth", result.limit?.limit)
        assertEquals("fair use", result.limit?.message)
        assertNull(FormatResult.fromJson(JSONObject("""{"text":"x","status":{"outcome":"used"}}""")).limit)
    }

    @Test
    fun `the wording names the limit, the allowance and the reset`() {
        val free = LimitNotice.fromJson(JSONObject(refusal()).getJSONObject("error"))!!
        val copy = Limits.describe(free, NOW)
        assertEquals("This week's free words are used up", copy.title)
        assertEquals("500 words a week on the free plan · resets Tue 15 Sep", copy.detail)
        assertTrue(copy.upgradeHelps)

        val day = Limits.describe(free.copy(limit = "dictationsPerDay", used = 12.0, allowed = 12.0, resetsAt = NOW + 5 * 3_600_000), NOW)
        assertEquals("Today's free dictations are used up", day.title)
        assertTrue(day.detail, day.detail.startsWith("12 dictations a day on the free plan · resets "))
        val unformatted = Limits.describe(free.copy(limit = "dictationsPerDay"), NOW, LimitStage.FORMATTING)
        assertEquals("Inserted without formatting", unformatted.title)
        assertEquals("Today's free dictations are used up · resets Tue 15 Sep", unformatted.detail)

        val minutes = Limits.describe(free.copy(limit = "sttSecondsPerWeek", allowed = 420.0), NOW)
        assertEquals("This week's free minutes are used up", minutes.title)
        assertEquals("7 min of speech a week on the free plan · resets Tue 15 Sep", minutes.detail)

        val clip = Limits.describe(free.copy(limit = "maxClipSeconds", used = 75.0, allowed = 60.0, resetsAt = null), NOW)
        assertEquals("That recording is too long for the free plan", clip.title)
        assertEquals("Clips up to 1 min on the free plan; up to 10 min on Pro", clip.detail)
    }

    @Test
    fun `Pro is not sold Pro`() {
        val pro = LimitNotice("sttSecondsPerMonth", "pro", "pro", 216_000.0, 216_000.0, utc(2026, Calendar.OCTOBER, 1), null, ACCOUNT, "")
        val cap = Limits.describe(pro, NOW)
        assertEquals("This month's fair-use cap is reached", cap.title)
        assertEquals("60 h a month on Pro · resets on 1 Oct", cap.detail)
        assertFalse(cap.upgradeHelps)

        val soft = Limits.describe(pro.copy(limit = "fairUseSttSecondsPerMonth", used = 108_500.0, allowed = 108_000.0), NOW, LimitStage.FORMATTING)
        assertEquals("Inserted without formatting", soft.title)
        assertEquals("Fair use reached for this month · resets on 1 Oct", soft.detail)
        assertFalse(soft.upgradeHelps)
        val paused = Limits.describe(pro.copy(limit = "fairUseSttSecondsPerMonth", used = 108_500.0, allowed = 108_000.0), NOW)
        assertEquals("Fair use reached for this month", paused.title)
        assertEquals("Past 30 h of transcription a month the text is tidied by rules only · resets on 1 Oct", paused.detail)

        val trialClip = Limits.describe(pro.copy(planState = "trial", limit = "maxClipSeconds", used = 700.0, allowed = 600.0, resetsAt = null), NOW)
        assertEquals("That recording is too long", trialClip.title)
        assertEquals("Clips can be up to 10 min", trialClip.detail)
    }

    @Test
    fun `resets are said the way a person would`() {
        assertEquals("in a moment", Limits.formatResetTime(NOW + 20_000, NOW))
        assertEquals("in 41 min", Limits.formatResetTime(NOW + 41 * 60_000, NOW))
        assertTrue(Limits.formatResetTime(NOW + 26 * 3_600_000, NOW).matches(Regex("tomorrow at \\d{1,2}:\\d{2} [ap]m")))
        assertEquals("Wed 16 Sep", Limits.formatResetTime(NOW + 3 * DAY, NOW))
        assertEquals("on 25 Sep", Limits.formatResetTime(NOW + 12 * DAY, NOW))
    }

    @Test
    fun `figures and meters read in their natural unit`() {
        assertEquals("7 min", Limits.formatAudioSeconds(420.0))
        assertEquals("120 min", Limits.formatAudioSeconds(7_200.0))
        assertEquals("<1 min", Limits.formatAudioSeconds(30.0))
        assertEquals("30 h", Limits.formatAudioSeconds(108_000.0))
        assertEquals("2.5 h", Limits.formatAudioSeconds(9_000.0, 108_000.0))
        assertEquals("312 of 500 words", Limits.meterValue("wordsPerWeek", 312.0, 500.0))
        assertEquals("2 of 7 min", Limits.meterValue("sttSecondsPerWeek", 95.0, 420.0))
        assertEquals("3 of 12", Limits.meterValue("dictationsPerDay", 3.0, 12.0))
        assertEquals("12k of 500k tokens", Limits.meterValue("llmTokensPerMonth", 12_400.0, 500_000.0))
        assertEquals("2.1M of 25M tokens", Limits.meterValue("llmTokensPerMonth", 2_100_000.0, 25_000_000.0))
        assertEquals("980 of 500k tokens", Limits.meterValue("llmTokensPerMonth", 980.0, 500_000.0))
        assertEquals("Words this week", Limits.meterLabel("wordsPerWeek"))
        val meters = listOf(
            UsageMeterDto("wordsPerWeek", 312.0, 500.0),
            UsageMeterDto("maxClipSeconds", 0.0, 60.0),
            UsageMeterDto("requestsPerMinute", 1.0, 20.0),
            UsageMeterDto("llmTokensPerMonth", 1.0, 500_000.0),
            UsageMeterDto("somethingNew", 1.0, 2.0)
        )
        assertEquals(listOf("wordsPerWeek", "llmTokensPerMonth"), Limits.usageMeters(meters).map { it.limit })
    }

    @Test
    fun `plan state comes from the instance, otherwise from the tier`() {
        assertEquals("trial", Limits.planStateOf(InferenceStatusDto(plan = "pro", planState = "trial"), null))
        assertEquals("pro", Limits.planStateOf(InferenceStatusDto(plan = "pro"), null))
        assertEquals("free", Limits.planStateOf(InferenceStatusDto(plan = "free"), null))
        assertEquals("trial", Limits.planStateOf(null, UserDto("u", "c", plan = "pro", planState = "trial")))
        assertEquals("free", Limits.planStateOf(null, null))
        assertEquals("Pro trial", Limits.planStateLabel("trial"))
        assertEquals("Pro trial", Limits.planTitle("trial"))
        assertEquals("Free plan", Limits.planTitle("free"))
        assertEquals(14, Limits.trialDaysLeft((NOW + 14 * DAY).toDouble(), NOW))
        assertEquals(1, Limits.trialDaysLeft((NOW + 1).toDouble(), NOW))
        assertEquals(0, Limits.trialDaysLeft((NOW - 5).toDouble(), NOW))
        assertEquals(0, Limits.trialDaysLeft(null, NOW))
    }

    @Test
    fun `Upgrade and Manage plan go only to whom they apply, and only with a page to open`() {
        assertEquals(PlanActions(UPGRADE, ACCOUNT), Limits.planActions("trial", UPGRADE, ACCOUNT))
        assertEquals(PlanActions(UPGRADE, null), Limits.planActions("free", UPGRADE, ACCOUNT))
        assertEquals(PlanActions(null, ACCOUNT), Limits.planActions("pro", null, ACCOUNT))
        // No site URL on the instance: nothing to open, so no buttons at all.
        for (state in listOf("trial", "free", "pro")) assertEquals(PlanActions(null, null), Limits.planActions(state, null, null))
        assertEquals(PlanActions(null, null), Limits.planActions("pro", "", ""))
        // The view folds the status in; an older instance without the field is the same as null.
        val view = InferenceView(
            cloudEnabled = true, managedAvailable = true, routing = InferenceRouting(InferenceSource.MURMUR, InferenceSource.MURMUR),
            signedIn = true, status = InferenceStatusDto(plan = "pro", planState = "pro"), plan = "pro", planState = "pro",
            trialDaysLeft = 0, sttReady = true, llmReady = true
        )
        assertEquals(PlanActions(null, null), view.planActions)
        assertEquals(PlanActions(null, ACCOUNT), view.copy(status = view.status?.copy(accountUrl = ACCOUNT)).planActions)
    }

    @Test
    fun `the status is asked for the UTC day, and again when it turns`() {
        assertEquals("2026-09-13", InferenceStatusDto.currentUtcDay(NOW))
        assertEquals(12 * 3_600_000L, InferenceStatusDto.msUntilNextUtcDay(NOW))
        assertEquals("2026-09-14", InferenceStatusDto.currentUtcDay(NOW + InferenceStatusDto.msUntilNextUtcDay(NOW)))
        assertEquals(1L, InferenceStatusDto.msUntilNextUtcDay(NOW + 12 * 3_600_000L - 1))
    }

    private fun utc(year: Int, month: Int, day: Int): Long =
        Calendar.getInstance(TimeZone.getTimeZone("UTC")).apply { clear(); set(year, month, day) }.timeInMillis
}
