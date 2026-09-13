package app.murmur.android

import app.murmur.android.cloud.AccountMode
import app.murmur.android.cloud.CloudConfig
import app.murmur.android.cloud.InferenceStatusDto
import app.murmur.android.cloud.InferenceUsageDto
import app.murmur.android.inference.Inference
import app.murmur.android.inference.InferenceRouter
import app.murmur.android.inference.InferenceRouting
import app.murmur.android.llm.ChatMessage
import app.murmur.android.llm.LlmConfig
import app.murmur.android.settings.InferenceSource
import app.murmur.android.settings.MurmurSettings
import app.murmur.android.settings.SttKind
import app.murmur.android.stt.SttErrorKind
import app.murmur.android.stt.SttException
import app.murmur.android.stt.errorFromResponse
import app.murmur.android.stt.parseErrorBody
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/** Same cases as apps/desktop/tests/inference.test.ts. */
class InferenceTest {
    private val key = "pk_test_Y2xlcmsuZXhhbXBsZS5jb20k"
    private val local = CloudConfig.OFF
    private val cloud = CloudConfig.resolve("https://happy-otter-123.convex.cloud", key, "")
    private val gateway = "https://happy-otter-123.convex.site/v1"

    private fun own() = MurmurSettings(
        sttSource = InferenceSource.CUSTOM,
        llmSource = InferenceSource.CUSTOM,
        sttKind = SttKind.OPENAI_COMPATIBLE,
        sttBaseUrl = "https://api.groq.com/openai/v1",
        sttApiKey = "sk-own",
        sttModel = "whisper-large-v3-turbo",
        sttFallbackModel = "whisper-large-v3",
        llmSameAsStt = true,
        llmModel = "openai/gpt-oss-20b"
    )

    private fun blank() = MurmurSettings(sttSource = InferenceSource.MURMUR, llmSource = InferenceSource.MURMUR, sttBaseUrl = "", sttModel = "", llmModel = "")

    @Test
    fun `local builds never route to Murmur whatever the settings say`() {
        val s = blank()
        assertEquals(InferenceRouting(InferenceSource.CUSTOM, InferenceSource.CUSTOM), Inference.resolveSources(s, cloudEnabled = false, managedAvailable = null))
        assertEquals(InferenceRouting(InferenceSource.CUSTOM, InferenceSource.CUSTOM), Inference.resolveSources(s, cloudEnabled = false, managedAvailable = true))
    }

    @Test
    fun `cloud builds default to Murmur for both stages, unless the instance has no models`() {
        val s = blank()
        assertEquals(InferenceRouting(InferenceSource.MURMUR, InferenceSource.MURMUR), Inference.resolveSources(s, true, null))
        assertEquals(InferenceRouting(InferenceSource.MURMUR, InferenceSource.MURMUR), Inference.resolveSources(s, true, true))
        assertEquals(InferenceRouting(InferenceSource.CUSTOM, InferenceSource.CUSTOM), Inference.resolveSources(s, true, false))
    }

    @Test
    fun `same server as speech follows the speech model wherever it points`() {
        val s = own()
        assertEquals(InferenceRouting(InferenceSource.CUSTOM, InferenceSource.CUSTOM), Inference.resolveSources(s, true, null))
        val murmurStt = s.copy(sttSource = InferenceSource.MURMUR)
        assertEquals(InferenceRouting(InferenceSource.MURMUR, InferenceSource.MURMUR), Inference.resolveSources(murmurStt, true, null))
        val ownLlm = murmurStt.copy(llmSameAsStt = false, llmBaseUrl = "http://127.0.0.1:11434/v1")
        assertEquals(InferenceRouting(InferenceSource.MURMUR, InferenceSource.CUSTOM), Inference.resolveSources(ownLlm, true, null))
        val murmurLlm = s.copy(llmSource = InferenceSource.MURMUR)
        assertEquals(InferenceRouting(InferenceSource.CUSTOM, InferenceSource.MURMUR), Inference.resolveSources(murmurLlm, true, null))
    }

    @Test
    fun `readiness depends on the resolved source`() {
        val murmur = InferenceRouting(InferenceSource.MURMUR, InferenceSource.MURMUR)
        val custom = InferenceRouting(InferenceSource.CUSTOM, InferenceSource.CUSTOM)
        assertFalse(Inference.sttReady(blank(), custom, signedIn = true))
        assertFalse(Inference.sttReady(blank(), murmur, signedIn = false))
        assertTrue(Inference.sttReady(blank(), murmur, signedIn = true))
        assertTrue(Inference.sttReady(own(), custom, signedIn = false))
        assertTrue(Inference.sttReady(blank().copy(sttKind = SttKind.DEEPGRAM, sttApiKey = "dg"), custom, false))
        assertTrue(Inference.llmReady(blank(), murmur, true))
        assertFalse(Inference.llmReady(blank(), custom, true))
        assertTrue(Inference.llmReady(own(), custom, false))
        assertFalse(Inference.llmReady(own().copy(llmModel = ""), custom, false))
    }

    @Test
    fun `the HTTP actions origin is derived from the Convex URL or given explicitly`() {
        assertEquals("https://happy-otter-123.convex.site", CloudConfig.deriveSiteUrl("https://happy-otter-123.convex.cloud"))
        assertEquals("http://127.0.0.1:3211", CloudConfig.deriveSiteUrl("http://127.0.0.1:3210"))
        assertNull(CloudConfig.deriveSiteUrl("https://convex.example.com"))
        assertNull(CloudConfig.deriveSiteUrl("nope"))
        assertEquals("https://happy-otter-123.convex.site", cloud.convexSiteUrl)
        assertTrue(cloud.managedModels)
        assertEquals("http://127.0.0.1:3211", CloudConfig.resolve("http://127.0.0.1:3210", key, "").convexSiteUrl)
        val explicit = CloudConfig.resolve("https://convex.murmur.example", key, "", "https://api.murmur.example/")
        assertEquals("https://api.murmur.example", explicit.convexSiteUrl)
        val underivable = CloudConfig.resolve("https://convex.murmur.example", key, "")
        assertEquals(AccountMode.REQUIRED, underivable.accountMode)
        assertEquals("", underivable.convexSiteUrl)
        assertFalse(underivable.managedModels)
        assertFalse(local.managedModels)
        assertEquals(gateway, Inference.gatewayUrl("https://happy-otter-123.convex.site/"))
    }

    @Test
    fun `gateway error codes reach the user verbatim`() {
        val quota = errorFromResponse(
            429,
            """{"error":{"message":"This month's 120 minutes of Murmur transcription on the free plan are used up","code":"quota_exceeded"}}"""
        )
        assertEquals(SttErrorKind.RATE_LIMIT, quota.kind)
        assertEquals("quota_exceeded", quota.code)
        assertTrue(quota.friendly().contains("120 minutes"))
        val other = errorFromResponse(429, """{"error":{"message":"Too Many Requests"}}""")
        assertNull(other.code)
        assertTrue(other.friendly().startsWith("Rate limited by the provider"))
        val (message, suggested, code) = parseErrorBody("""{"error":{"message":"Unknown model \"x\". Available models: murmur-transcribe","code":"model_not_found"}}""")
        assertEquals("model_not_found", code)
        assertEquals(listOf("murmur-transcribe"), suggested)
        assertTrue(message.startsWith("Unknown model"))
        val pair: Pair<String, List<String>> = parseErrorBody("plain text").let { (m, s) -> m to s }
        assertEquals("plain text" to emptyList<String>(), pair)
    }

    @Test
    fun `usage is only counted for the current month`() {
        val period = InferenceStatusDto.currentPeriod()
        val status = InferenceStatusDto(available = true, usage = InferenceUsageDto(period = period, sttSeconds = 90.0, llmTokens = 12.0))
        assertEquals(90.0, status.sttSecondsIn(period), 0.0)
        assertEquals(0.0, status.sttSecondsIn("1999-01"), 0.0)
        // 2025-09-04T14:13:20Z
        assertEquals("2025-09", InferenceStatusDto.currentPeriod(1_757_000_000_000L))
        // Month boundaries are UTC: 2025-12-31T23:59:59Z stays in December.
        assertEquals("2025-12", InferenceStatusDto.currentPeriod(1_767_225_599_000L))
    }

    private class Harness(
        config: CloudConfig,
        private var settings: MurmurSettings,
        tokens: List<String?> = emptyList(),
        signedIn: Boolean = true,
        managed: Boolean? = null
    ) {
        val requests = ArrayList<Boolean>()
        private val queue = ArrayDeque(tokens)
        val router = InferenceRouter(
            config = config,
            settings = { settings },
            token = { force ->
                requests.add(force)
                queue.removeFirstOrNull()
            },
            signedIn = { signedIn },
            managedAvailable = { managed }
        )
    }

    @Test
    fun `local builds use the device provider and never ask for a token`() = runBlocking {
        val h = Harness(local, own(), tokens = listOf("should-not-be-asked"))
        assertFalse(h.router.cloudEnabled)
        val stt = h.router.stt()
        assertEquals(InferenceSource.CUSTOM, stt.source)
        assertEquals("openai-compatible", stt.provider)
        assertEquals("whisper-large-v3", stt.fallbackModel)
        assertEquals("https://api.groq.com/openai/v1", stt.cfg.baseUrl)
        assertEquals("sk-own", stt.cfg.apiKey)
        val llm = h.router.llm()
        assertEquals(LlmConfig("https://api.groq.com/openai/v1", "sk-own", "openai/gpt-oss-20b", 15_000), llm.cfg)
        val blankLocal = Harness(local, blank(), tokens = listOf("nope"))
        assertEquals(InferenceSource.CUSTOM, blankLocal.router.stt().source)
        assertEquals(InferenceSource.CUSTOM, blankLocal.router.llm().source)
        assertTrue(h.requests.isEmpty())
        assertTrue(blankLocal.requests.isEmpty())
    }

    @Test
    fun `cloud builds point at the gateway with the session token as the key`() = runBlocking {
        val h = Harness(cloud, blank().copy(language = "de", sttTimeoutMs = 30_000), tokens = listOf("jwt-1", "jwt-1"))
        assertTrue(h.router.cloudEnabled)
        val stt = h.router.stt()
        assertEquals(InferenceSource.MURMUR, stt.source)
        assertEquals(Inference.PROVIDER, stt.provider)
        assertEquals("", stt.fallbackModel)
        assertEquals(SttKind.OPENAI_COMPATIBLE, stt.cfg.kind)
        assertEquals(gateway, stt.cfg.baseUrl)
        assertEquals("jwt-1", stt.cfg.apiKey)
        assertEquals(Inference.STT_MODEL, stt.cfg.model)
        assertEquals("de", stt.cfg.language)
        assertEquals(30_000, stt.cfg.timeoutMs)
        val llm = h.router.llm()
        assertEquals(LlmConfig(gateway, "jwt-1", Inference.LLM_MODEL, 15_000), llm.cfg)
        assertEquals(listOf(false, false), h.requests)
        assertTrue(h.router.isMurmur("$gateway/"))
        assertFalse(h.router.isMurmur("https://api.groq.com/openai/v1"))

        val chosen = Harness(cloud, own(), tokens = listOf("jwt"))
        assertEquals("sk-own", chosen.router.stt().cfg.apiKey)
        assertTrue(chosen.requests.isEmpty())
        val none = Harness(cloud, blank(), tokens = listOf("jwt"), managed = false)
        assertEquals(InferenceSource.CUSTOM, none.router.stt().source)
        assertTrue(none.requests.isEmpty())
    }

    @Test
    fun `a missing session token is explained`() = runBlocking {
        val signedOut = Harness(cloud, blank(), tokens = listOf(null), signedIn = false)
        try {
            signedOut.router.stt()
            fail("expected an error")
        } catch (e: SttException) {
            assertEquals("murmur_signed_out", e.code)
            assertTrue(e.friendly().startsWith("Sign in to use Murmur models"))
        }
        val noToken = Harness(cloud, blank(), tokens = listOf(null), signedIn = true)
        val (llm, why) = noToken.router.llmOrNull()
        assertNull(llm)
        assertTrue(why!!.contains("session token"))
    }

    @Test
    fun `an expired token is refreshed once and the request retried`() = runBlocking {
        val server = MockWebServer()
        val seen = ArrayList<String?>()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val auth = request.getHeader("Authorization")
                seen.add(auth)
                if (auth == "Bearer jwt-old") {
                    return MockResponse().setResponseCode(401)
                        .setHeader("Content-Type", "application/json")
                        .setBody("""{"error":{"message":"Sign in to use Murmur models","code":"unauthorized"}}""")
                }
                return MockResponse().setHeader("Content-Type", "application/json").setBody(
                    if (request.path!!.endsWith("/chat/completions"))
                        """{"choices":[{"message":{"content":"Hello."},"finish_reason":"stop"}],"model":"murmur-format"}"""
                    else """{"text":"hello there","language":"en"}"""
                )
            }
        }
        server.start()
        try {
            val site = "http://${server.hostName}:${server.port}"
            val config = CloudConfig.resolve("https://x.convex.cloud", key, "", site)
            val h = Harness(config, blank(), tokens = listOf("jwt-old", "jwt-new", "jwt-old", "jwt-new"))
            val llm = h.router.llm()
            val res = h.router.complete(llm.cfg, listOf(ChatMessage("user", "hello")))
            assertEquals("Hello.", res.text)
            assertEquals(listOf("Bearer jwt-old", "Bearer jwt-new"), seen)
            assertEquals(listOf(false, true), h.requests)

            seen.clear()
            val stt = h.router.stt()
            val out = h.router.transcribe(stt, ByteArray(64), null)
            assertEquals("hello there", out.text)
            assertEquals(listOf("Bearer jwt-old", "Bearer jwt-new"), seen)
            // The refreshed token sticks for the resume rounds of the same dictation.
            assertEquals("jwt-new", stt.cfg.apiKey)
        } finally {
            server.shutdown()
        }
    }

    @Test
    fun `an own-provider 401 is not retried and a failing own model falls back`() = runBlocking {
        val server = MockWebServer()
        val models = ArrayList<String>()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                if (request.path!!.endsWith("/chat/completions")) {
                    return MockResponse().setResponseCode(401).setBody("""{"error":{"message":"Invalid API key"}}""")
                }
                val body = request.body.readUtf8()
                val model = Regex("name=\"model\"\\r\\n\\r\\n([^\\r]+)").find(body)?.groupValues?.get(1) ?: "?"
                models.add(model)
                return if (model == "broken") MockResponse().setResponseCode(503).setBody("down")
                else MockResponse().setHeader("Content-Type", "application/json").setBody("""{"text":"ok"}""")
            }
        }
        server.start()
        try {
            val base = "http://${server.hostName}:${server.port}/v1"
            val s = own().copy(sttBaseUrl = base, sttModel = "broken", sttFallbackModel = "backup")
            val h = Harness(cloud, s, tokens = listOf("jwt"))
            val stt = h.router.stt()
            assertEquals("ok", h.router.transcribe(stt, ByteArray(64), null).text)
            assertEquals(listOf("broken", "backup"), models)
            assertTrue(h.requests.isEmpty())

            try {
                h.router.complete(h.router.llm().cfg, listOf(ChatMessage("user", "x")))
                fail("a 401 from the user's own server must surface")
            } catch (e: SttException) {
                assertEquals(SttErrorKind.AUTH, e.kind)
                assertNull(e.code)
                // A failure against the user's own server is never answered with a Murmur token.
                assertTrue(h.requests.isEmpty())
            }
        } finally {
            server.shutdown()
        }
    }
}
