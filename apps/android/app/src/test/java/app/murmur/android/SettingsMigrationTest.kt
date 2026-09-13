package app.murmur.android

import android.content.Context
import app.murmur.android.settings.SettingsStore
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

private const val GROQ = "https://api.groq.com/openai/v1"
private const val PREFS = "murmur_settings"

/**
 * An install that still names a model its provider retired is moved onto the replacement when the
 * store opens, exactly once: after that whatever it names is the user's own choice.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class SettingsMigrationTest {
    private lateinit var context: Context

    @Before
    fun setUp() {
        context = RuntimeEnvironment.getApplication()
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().clear().commit()
    }

    private fun seed(vararg pairs: Pair<String, Any>) {
        val editor = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
        for ((key, value) in pairs) when (value) {
            is String -> editor.putString(key, value)
            is Boolean -> editor.putBoolean(key, value)
            is Int -> editor.putInt(key, value)
            else -> error("unsupported $value")
        }
        editor.commit()
    }

    @Test
    fun `a store written before the retirement is moved onto the replacement models`() {
        seed(
            "sttSource" to "custom",
            "sttBaseUrl" to GROQ,
            "sttModel" to "distil-whisper-large-v3-en",
            "llmSameAsStt" to true,
            "llmModel" to "llama-3.1-8b-instant"
        )
        val s = SettingsStore(context).get()
        assertEquals("whisper-large-v3-turbo", s.sttModel)
        assertEquals("openai/gpt-oss-20b", s.llmModel)
        assertEquals(GROQ, s.sttBaseUrl)
        // Persisted, and the run is recorded.
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        assertEquals("openai/gpt-oss-20b", prefs.getString("llmModel", null))
        assertEquals(1, prefs.getInt("modelMigration", 0))
    }

    @Test
    fun `runs once - a retired id chosen after the migration stays`() {
        seed(
            "sttSource" to "custom",
            "sttBaseUrl" to GROQ,
            "sttModel" to "whisper-large-v3-turbo",
            "llmSameAsStt" to true,
            "llmModel" to "llama-3.1-8b-instant",
            "modelMigration" to 1
        )
        assertEquals("llama-3.1-8b-instant", SettingsStore(context).get().llmModel)
    }

    @Test
    fun `a fresh install has nothing to move and is simply stamped`() {
        val s = SettingsStore(context).get()
        assertEquals("", s.llmModel)
        assertEquals(1, context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getInt("modelMigration", 0))
    }
}
