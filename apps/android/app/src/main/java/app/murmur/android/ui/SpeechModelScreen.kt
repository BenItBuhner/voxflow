package app.murmur.android.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import app.murmur.android.inference.Inference
import app.murmur.android.settings.InferenceSource
import app.murmur.android.settings.MurmurSettings
import app.murmur.android.settings.SettingsStore
import app.murmur.android.settings.SttKind
import app.murmur.android.stt.SttClient
import app.murmur.android.ui.components.Chip
import app.murmur.android.ui.components.ChipRow
import app.murmur.android.ui.components.ControlRow
import app.murmur.android.ui.components.Field
import app.murmur.android.ui.components.Group
import app.murmur.android.ui.components.Notice
import app.murmur.android.ui.components.NoticeTone
import app.murmur.android.ui.components.Screen
import app.murmur.android.ui.components.SecondaryButton
import app.murmur.android.ui.components.SectionGap
import app.murmur.android.ui.theme.Murmur
import kotlinx.coroutines.launch

@Composable
fun SpeechModelScreen(store: SettingsStore, settings: MurmurSettings, nav: TopNav) {
    val inference = rememberInferenceView(settings)
    Screen(
        title = "Speech model",
        description = if (inference.offersMurmur)
            "The models that come with your account, or a transcription service you choose. Keys for your own service stay on this phone and are never synced."
        else
            "Recordings go to a transcription service you choose. Keys stay on this phone and are never synced.",
        nav = nav
    ) {
        SpeechModelForm(store, settings)
    }
}

/**
 * Where speech goes. In cloud builds a chooser between the instance's models and the user's own
 * provider comes first; local builds only ever show the provider form. Shared by the settings
 * screen and onboarding.
 */
@Composable
fun SpeechModelForm(store: SettingsStore, settings: MurmurSettings, showAdvanced: Boolean = true) {
    val inference = rememberInferenceView(settings)
    if (inference.offersMurmur) {
        SourceChooser(
            title = "Speech model",
            selected = settings.sttSource,
            murmurMeta = listOfNotNull(inference.planTitle, inference.minutesLabel).joinToString(" · "),
            onSelect = { source -> store.update { s -> s.copy(sttSource = source) } }
        )
        SectionGap()
    } else if (inference.cloudEnabled && !inference.managedAvailable) {
        Notice("This Murmur instance does not provide speech models of its own, so Murmur uses the provider you connect here.")
        SectionGap()
    }
    if (inference.routing.murmurStt) MurmurSpeechSummary(inference) else OwnProviderForm(store, settings, showAdvanced)
}

/** Murmur models vs. the user's own provider. Only rendered in builds that talk to an instance. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun SourceChooser(
    title: String,
    selected: InferenceSource,
    murmurMeta: String,
    onSelect: (InferenceSource) -> Unit,
    ownLabel: String = "Your own provider"
) {
    Group(title) {
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Chip("Murmur models", selected = selected == InferenceSource.MURMUR, onClick = { onSelect(InferenceSource.MURMUR) })
            Chip(ownLabel, selected = selected == InferenceSource.CUSTOM, onClick = { onSelect(InferenceSource.CUSTOM) })
        }
        Spacer(Modifier.height(10.dp))
        Text(
            when (selected) {
                InferenceSource.MURMUR ->
                    "Included with your account ($murmurMeta). Nothing to set up: your recording goes to this Murmur instance, which transcribes it with the models it provides."
                InferenceSource.CUSTOM ->
                    "OpenAI, Groq, Deepgram, ElevenLabs or a local whisper server with your own key. Audio goes straight from this phone to that provider and never touches Murmur’s servers."
            },
            style = Murmur.type.bodySmall,
            color = Murmur.colors.inkSoft
        )
    }
}

@Composable
private fun MurmurSpeechSummary(inference: InferenceView) {
    val c = Murmur.colors
    Group(rows = true) {
        ControlRow("Model", description = "Provided by this Murmur instance for your account. Your dictionary still biases recognition.") {
            Text(inference.status?.models?.stt ?: Inference.STT_MODEL, style = Murmur.type.labelSmall, color = c.inkSoft)
        }
        ControlRow(
            "Plan",
            description = when {
                !inference.signedIn -> "Sign in to use Murmur models."
                inference.minutesLabel != null -> "Transcription minutes reset at the start of every month."
                else -> "Waiting for your account status…"
            }
        ) {
            Text(
                listOfNotNull(inference.planLabel, inference.minutesLabel).joinToString(" · "),
                style = Murmur.type.labelSmall,
                color = c.inkSoft
            )
        }
    }
}

/** Provider, connection and model for the user's own service. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun OwnProviderForm(store: SettingsStore, settings: MurmurSettings, showAdvanced: Boolean) {
    val scope = rememberCoroutineScope()
    var models by remember { mutableStateOf<List<String>>(emptyList()) }
    var discovering by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val kind = settings.sttKind

    Group("Provider") {
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            for (k in SttKind.entries) {
                Chip(k.displayName, selected = kind == k, onClick = {
                    models = emptyList()
                    error = null
                    store.update { s -> s.copy(sttKind = k) }
                })
            }
        }
        Spacer(Modifier.height(10.dp))
        Text(
            when (kind) {
                SttKind.OPENAI_COMPATIBLE -> "OpenAI, Groq, or any server with a /v1/audio/transcriptions endpoint, including a local whisper server."
                SttKind.DEEPGRAM -> "Deepgram's Nova models. Only the API key is required."
                SttKind.ELEVENLABS -> "ElevenLabs Scribe. Only the API key is required."
            },
            style = Murmur.type.bodySmall,
            color = Murmur.colors.inkSoft
        )
    }

    SectionGap()

    Group("Connection") {
        Field(
            value = settings.sttBaseUrl,
            onValueChange = { store.update { s -> s.copy(sttBaseUrl = it) } },
            label = if (kind == SttKind.OPENAI_COMPATIBLE) "Server" else "Server (optional)",
            placeholder = when (kind) {
                SttKind.OPENAI_COMPATIBLE -> "https://api.groq.com/openai/v1"
                SttKind.DEEPGRAM -> "https://api.deepgram.com/v1"
                SttKind.ELEVENLABS -> "https://api.elevenlabs.io/v1"
            },
            helper = if (kind == SttKind.OPENAI_COMPATIBLE) null else "Leave empty to use the provider's own servers.",
            keyboardType = KeyboardType.Uri
        )
        Spacer(Modifier.height(20.dp))
        Field(
            value = settings.sttApiKey,
            onValueChange = { store.update { s -> s.copy(sttApiKey = it) } },
            label = "API key",
            placeholder = "Paste a key",
            secret = true
        )
        Spacer(Modifier.height(20.dp))
        Field(
            value = settings.sttModel,
            onValueChange = { store.update { s -> s.copy(sttModel = it) } },
            label = "Model",
            placeholder = when (kind) {
                SttKind.OPENAI_COMPATIBLE -> "whisper-large-v3-turbo"
                SttKind.DEEPGRAM -> "nova-3"
                SttKind.ELEVENLABS -> "scribe_v1"
            }
        )
        Spacer(Modifier.height(14.dp))
        Row {
            SecondaryButton(
                text = if (discovering) "Looking…" else "Discover models",
                compact = true,
                loading = discovering,
                enabled = !discovering && (kind != SttKind.OPENAI_COMPATIBLE || settings.sttBaseUrl.isNotBlank()),
                onClick = {
                    discovering = true
                    error = null
                    scope.launch {
                        try {
                            models = SttClient.listModels(sttConfig(settings))
                        } catch (e: Exception) {
                            error = "Could not list models: ${friendlyMessage(e)}"
                        } finally {
                            discovering = false
                        }
                    }
                }
            )
        }
        if (models.isNotEmpty()) {
            Spacer(Modifier.height(16.dp))
            ChipRow(models.take(12), settings.sttModel) { store.update { s -> s.copy(sttModel = it) } }
        }
        error?.let {
            Spacer(Modifier.height(14.dp))
            Notice(it, NoticeTone.ERROR)
        }
    }

    if (showAdvanced) {
        SectionGap()
        Group("Resilience") {
            Field(
                value = settings.sttFallbackModel,
                onValueChange = { store.update { s -> s.copy(sttFallbackModel = it) } },
                label = "Fallback model",
                placeholder = "Optional",
                helper = "Tried when the first model is unavailable or rate limited."
            )
        }
    }
}
