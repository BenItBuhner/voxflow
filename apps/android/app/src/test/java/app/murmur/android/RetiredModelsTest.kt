package app.murmur.android

import app.murmur.android.settings.MurmurSettings
import app.murmur.android.settings.RetiredModels
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Test

private const val GROQ = "https://api.groq.com/openai/v1"
private const val OPENAI = "https://api.openai.com/v1"

/** The retired-model table and the settings rewrite built on it (port of shared/models.ts). */
class RetiredModelsTest {

    @Test
    fun `retired ids map to the provider's recommended replacement`() {
        assertEquals("openai/gpt-oss-20b", RetiredModels.replacement(GROQ, "llama-3.1-8b-instant"))
        assertEquals("openai/gpt-oss-120b", RetiredModels.replacement(GROQ, "llama-3.3-70b-versatile"))
        assertEquals("whisper-large-v3-turbo", RetiredModels.replacement(GROQ, "distil-whisper-large-v3-en"))
        assertEquals("gpt-5.6-luna", RetiredModels.replacement(OPENAI, "gpt-4.1-nano"))
        assertEquals("gpt-5.6-luna", RetiredModels.replacement(OPENAI, "gpt-4.1-nano-2025-04-14"))
        // Host matching is case-insensitive and ignores the path.
        assertEquals("openai/gpt-oss-20b", RetiredModels.replacement("HTTPS://API.GROQ.COM/openai/v1/", " llama-3.1-8b-instant "))
    }

    @Test
    fun `models that are current, or live on another host, are left alone`() {
        assertNull(RetiredModels.replacement(GROQ, "whisper-large-v3-turbo"))
        assertNull(RetiredModels.replacement(GROQ, "openai/gpt-oss-20b"))
        assertNull(RetiredModels.replacement(OPENAI, "gpt-4o-mini"))
        // Groq's id on a proxy or a local server is not Groq's to retire.
        assertNull(RetiredModels.replacement("https://litellm.example.com/v1", "llama-3.1-8b-instant"))
        assertNull(RetiredModels.replacement("http://127.0.0.1:11434/v1", "llama-3.1-8b-instant"))
        assertNull(RetiredModels.replacement("", "llama-3.1-8b-instant"))
        assertNull(RetiredModels.replacement("not a url", "llama-3.1-8b-instant"))
    }

    @Test
    fun `migrate rewrites the speech, fallback and formatting models against their own servers`() {
        val groqEverything = MurmurSettings(
            sttBaseUrl = GROQ,
            sttModel = "distil-whisper-large-v3-en",
            sttFallbackModel = "llama-3.1-8b-instant",
            llmSameAsStt = true,
            llmModel = "llama-3.3-70b-versatile"
        )
        val migrated = RetiredModels.migrate(groqEverything)
        assertEquals("whisper-large-v3-turbo", migrated.sttModel)
        assertEquals("openai/gpt-oss-20b", migrated.sttFallbackModel)
        assertEquals("openai/gpt-oss-120b", migrated.llmModel)

        // A separate formatting server is judged on its own host, not the speech server's.
        val separate = MurmurSettings(
            sttBaseUrl = GROQ,
            sttModel = "whisper-large-v3-turbo",
            llmSameAsStt = false,
            llmBaseUrl = OPENAI,
            llmModel = "gpt-4.1-nano"
        )
        assertEquals("gpt-5.6-luna", RetiredModels.migrate(separate).llmModel)
        val proxied = separate.copy(llmBaseUrl = "https://proxy.example.com/v1", llmModel = "llama-3.1-8b-instant")
        assertEquals("llama-3.1-8b-instant", RetiredModels.migrate(proxied).llmModel)

        // Nothing to change: the same instance comes back.
        val current = MurmurSettings(sttBaseUrl = GROQ, sttModel = "whisper-large-v3-turbo", llmModel = "openai/gpt-oss-20b")
        assertSame(current, RetiredModels.migrate(current))
        val blank = MurmurSettings()
        assertSame(blank, RetiredModels.migrate(blank))
    }
}
