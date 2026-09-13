package app.murmur.android.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalContext
import app.murmur.android.MurmurApplication
import app.murmur.android.cloud.CloudConfig
import app.murmur.android.cloud.CloudSync
import app.murmur.android.cloud.InferenceStatusDto
import app.murmur.android.cloud.UsageMeterDto
import app.murmur.android.inference.Inference
import app.murmur.android.inference.InferenceRouting
import app.murmur.android.inference.Limits
import app.murmur.android.settings.InferenceSource
import app.murmur.android.settings.MurmurSettings
import app.murmur.android.settings.SttKind
import app.murmur.android.stt.SttConfig
import app.murmur.android.stt.SttException
import com.clerk.api.Clerk
import java.util.Calendar
import kotlinx.coroutines.flow.MutableStateFlow

/** The resolved view of where speech and formatting run, shared by the settings screens. */
data class InferenceView(
    /** This build talks to a configured instance, so Murmur models are a possible choice at all. */
    val cloudEnabled: Boolean,
    /** The instance offers managed models (true until the account status says otherwise). */
    val managedAvailable: Boolean,
    val routing: InferenceRouting,
    val signedIn: Boolean,
    val status: InferenceStatusDto?,
    val plan: String,
    /** Trial, free or Pro: the plan the account is on, as distinct from the tier whose limits apply. */
    val planState: String,
    /** Whole days left on the Pro trial; 0 outside of one. */
    val trialDaysLeft: Int,
    val sttReady: Boolean,
    val llmReady: Boolean
) {
    /** Murmur models can be offered in the UI. */
    val offersMurmur: Boolean get() = cloudEnabled && managedAvailable

    /** "Pro trial", "Free", "Pro". */
    val planLabel: String get() = Limits.planStateLabel(planState)

    /** "Pro trial", "Free plan", "Pro plan". */
    val planTitle: String get() = Limits.planTitle(planState)

    /** The rolling and monthly allowances of the tier, with what is used and when each resets. */
    val meters: List<UsageMeterDto> get() = Limits.usageMeters(status?.meters ?: emptyList())

    /** The web page that starts an upgrade, or null when the instance offers none (hide the button). */
    val upgradeUrl: String? get() = status?.upgradeUrl

    /** Pro past the soft fair-use cap: the formatting model is paused until the month resets. */
    val formattingPaused: Boolean get() = status?.formattingPaused == true

    /** "12 of 120 min this month" (or "1.5 of 60 h this month"), or null before the account status arrived. */
    val minutesLabel: String?
        get() {
            val s = status ?: return null
            val used = s.sttSecondsIn(InferenceStatusDto.currentPeriod())
            return "${Limits.meterValue("sttSecondsPerMonth", used, s.limits.sttSecondsPerMonth)} this month"
        }
}

/** Build configuration, sync status and Clerk session folded into one view for the current settings. */
@Composable
fun rememberInferenceView(settings: MurmurSettings): InferenceView {
    val app = LocalContext.current.applicationContext
    val config = (app as? MurmurApplication)?.cloudConfig ?: CloudConfig.OFF
    val syncStatus = CloudSync.get()?.status?.collectAsState()?.value
    val clerkUser by (if (config.enabled) Clerk.userFlow else remember { MutableStateFlow(null) }).collectAsState()
    val signedIn = config.enabled && clerkUser != null
    val status = syncStatus?.inference
    val managedAvailable = status?.available ?: true
    val routing = Inference.resolveSources(settings, config.managedModels, managedAvailable)
    return InferenceView(
        cloudEnabled = config.managedModels,
        managedAvailable = managedAvailable,
        routing = routing,
        signedIn = signedIn,
        status = status,
        plan = status?.plan ?: syncStatus?.user?.plan ?: "free",
        planState = Limits.planStateOf(status, syncStatus?.user),
        trialDaysLeft = Limits.trialDaysLeft(status?.trialEndsAt ?: syncStatus?.user?.trialEndsAt),
        sttReady = Inference.sttReady(settings, routing, signedIn),
        llmReady = Inference.llmReady(settings, routing, signedIn)
    )
}

val InferenceRouting.murmurStt: Boolean get() = stt == InferenceSource.MURMUR
val InferenceRouting.murmurLlm: Boolean get() = llm == InferenceSource.MURMUR

fun sttConfig(s: MurmurSettings) = SttConfig(
    kind = s.sttKind,
    baseUrl = s.sttBaseUrl,
    apiKey = s.sttApiKey,
    model = s.sttModel,
    language = s.language,
    timeoutMs = s.sttTimeoutMs
)

fun friendlyMessage(e: Exception): String =
    if (e is SttException) e.friendly() else e.message ?: "Something went wrong"

/** The user's own speech provider has what it needs to take a request (see [InferenceView.sttReady] for the resolved source). */
val MurmurSettings.ownProviderConfigured: Boolean
    get() = when (sttKind) {
        SttKind.OPENAI_COMPATIBLE -> sttBaseUrl.isNotBlank() && sttModel.isNotBlank()
        SttKind.DEEPGRAM, SttKind.ELEVENLABS -> sttApiKey.isNotBlank()
    }

val SttKind.displayName: String
    get() = when (this) {
        SttKind.OPENAI_COMPATIBLE -> "OpenAI-compatible"
        SttKind.DEEPGRAM -> "Deepgram"
        SttKind.ELEVENLABS -> "ElevenLabs"
    }

fun greetingFor(hour: Int = Calendar.getInstance().get(Calendar.HOUR_OF_DAY)): String = when {
    hour < 5 -> "Good evening"
    hour < 12 -> "Good morning"
    hour < 18 -> "Good afternoon"
    else -> "Good evening"
}

fun pluralize(count: Int, singular: String, plural: String = singular + "s"): String =
    "$count ${if (count == 1) singular else plural}"
