package app.murmur.android.ui

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import app.murmur.android.cloud.CloudConfig
import app.murmur.android.cloud.CloudSync
import app.murmur.android.cloud.SyncPhase
import app.murmur.android.cloud.SyncStatus
import app.murmur.android.cloud.UsageMeterDto
import app.murmur.android.inference.Limits
import app.murmur.android.settings.SettingsStore
import app.murmur.android.ui.components.ControlRow
import app.murmur.android.ui.components.Dot
import app.murmur.android.ui.components.Group
import app.murmur.android.ui.components.PrimaryButton
import app.murmur.android.ui.components.Screen
import app.murmur.android.ui.components.SecondaryButton
import app.murmur.android.ui.components.SectionGap
import app.murmur.android.ui.components.Tag
import app.murmur.android.ui.theme.Murmur
import app.murmur.android.ui.theme.Paper
import app.murmur.android.ui.theme.Radii
import app.murmur.android.ui.theme.Space
import com.clerk.api.Clerk
import kotlinx.coroutines.launch

fun syncLabel(status: SyncStatus): String = when (status.phase) {
    SyncPhase.SYNCED -> "Synced"
    SyncPhase.SYNCING -> "Syncing ${status.pendingOps}…"
    SyncPhase.CONNECTING -> "Connecting…"
    SyncPhase.OFFLINE -> if (status.pendingOps > 0) "Offline, ${status.pendingOps} pending" else "Offline"
    SyncPhase.ERROR -> "Sync issue: ${status.error ?: "retrying"}"
    SyncPhase.SIGNED_OUT -> "Signed out"
    SyncPhase.DISABLED -> "Local"
}

@Composable
fun syncColor(status: SyncStatus, c: Paper = Murmur.colors): Color = when (status.phase) {
    SyncPhase.SYNCED -> c.sage
    SyncPhase.ERROR -> c.clay
    SyncPhase.SYNCING, SyncPhase.CONNECTING -> c.ember
    else -> c.inkMuted
}

@Composable
fun AccountScreen(config: CloudConfig, store: SettingsStore, nav: TopNav, onSignIn: () -> Unit) {
    val sync = CloudSync.get()
    val status by (sync?.status ?: return).collectAsState()
    val user by Clerk.userFlow.collectAsState()
    val settings by store.flow.collectAsState()
    val scope = rememberCoroutineScope()
    val c = Murmur.colors

    if (user == null) {
        Screen(
            title = "Account",
            description = "You are using Murmur without an account. Everything stays on this phone.",
            nav = nav
        ) {
            Text(
                "Sign in to carry your dictionary and style to your other devices. The words already on this phone are merged into the account the first time.",
                style = Murmur.type.body,
                color = c.inkSoft
            )
            Spacer(Modifier.height(28.dp))
            PrimaryButton("Sign in or create an account", onClick = onSignIn, modifier = Modifier.fillMaxWidth())
        }
        return
    }

    val name = status.user?.name
        ?: listOfNotNull(user?.firstName, user?.lastName).joinToString(" ").ifBlank { "Your account" }
    val email = status.user?.email ?: user?.primaryEmailAddress?.emailAddress
    val inference = rememberInferenceView(settings)

    Screen(title = "Account", nav = nav) {
        Text(name, style = Murmur.type.displaySmall, color = c.ink)
        if (email != null) {
            Spacer(Modifier.height(6.dp))
            Text(email, style = Murmur.type.body, color = c.inkSoft)
        }

        SectionGap()

        PlanGroup(inference)

        SectionGap()

        Group(rows = true) {
            ControlRow("Sync", description = "Dictionary and style preferences. Your model choice and any API keys of your own stay on this phone.") {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Dot(syncColor(status), size = 6.dp, pulsing = status.phase == SyncPhase.SYNCING)
                    Spacer(Modifier.width(8.dp))
                    Text(syncLabel(status), style = Murmur.type.labelSmall, color = c.inkSoft)
                }
            }
            ControlRow("Devices") {
                Text(pluralize(status.devices.size, "device"), style = Murmur.type.labelSmall, color = c.inkSoft)
            }
            ControlRow("Dictionary") {
                Text(pluralize(settings.dictionaryEntries.size, "word"), style = Murmur.type.labelSmall, color = c.inkSoft)
            }
        }

        Spacer(Modifier.height(28.dp))

        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            SecondaryButton("Sync now", onClick = { sync.syncNow() })
            SecondaryButton("Sign out", onClick = { scope.launch { sync.signOut() } })
        }

        SectionGap()

        Text("Instance", style = Murmur.type.overline, color = c.inkMuted)
        Spacer(Modifier.height(6.dp))
        Text(config.convexUrl, style = Murmur.type.bodySmall, color = c.inkMuted)
    }
}

/** What the plan means for the account right now, in one sentence. */
fun planDescription(inference: InferenceView): String {
    if (!inference.managedAvailable) return "This Murmur instance does not provide models of its own; connect your provider under Speech model."
    if (inference.status == null) return "Waiting for your account status…"
    return when (inference.planState) {
        "trial" -> "${if (inference.trialDaysLeft == 1) "1 day" else "${inference.trialDaysLeft} days"} left with everything Pro offers, no card needed. Afterwards the free plan carries on with a weekly allowance; upgrade whenever you want to keep dictating without one."
        "pro" -> if (inference.formattingPaused)
            "Unlimited dictation within fair use. The formatting model is paused for the rest of this month; your text is still transcribed and tidied by rules."
        else
            "Unlimited dictation within fair use: the meters below show how far this month has come. Manage the subscription from your account page."
        else -> "A weekly allowance of free words and speech, a handful of dictations a day, clips up to a minute. Upgrade for unlimited dictation, or connect your own provider under Speech model."
    }
}

/**
 * The account's plan: where it stands (trial, free, Pro), how much of each allowance is used and
 * when it comes back, and the one action that changes it. Upgrade opens the web account page in
 * the browser; the button is only shown when the instance has one.
 */
@Composable
fun PlanGroup(inference: InferenceView) {
    val c = Murmur.colors
    val context = LocalContext.current
    val open: (String?) -> Unit = { url ->
        if (url != null) runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) }
    }
    val upgrade = inference.upgradeUrl?.takeIf { inference.planState != "pro" }
    val paused = inference.meters.firstOrNull { it.limit == "fairUseSttSecondsPerMonth" }
    Group(rows = true) {
        ControlRow(inference.planTitle, description = planDescription(inference)) {
            Tag(
                if (inference.planState == "trial" && inference.trialDaysLeft > 0) "${inference.trialDaysLeft}d left" else inference.planLabel,
                color = when (inference.planState) {
                    "pro" -> c.sage
                    "trial" -> c.emberText
                    else -> c.inkSoft
                }
            )
        }
        if (inference.formattingPaused && paused != null) {
            Column(
                Modifier
                    .fillMaxWidth()
                    .padding(bottom = Space.row)
                    .clip(RoundedCornerShape(Radii.nested(Radii.card, Space.card)))
                    .background(c.ember.copy(alpha = if (c.isDark) 0.16f else 0.1f))
                    .padding(horizontal = 14.dp, vertical = 12.dp)
            ) {
                Text(
                    "Formatting paused until ${Limits.formatResetTime(paused.resetsAt.toLong()).removePrefix("on ")}",
                    style = Murmur.type.title,
                    color = c.ink
                )
                Spacer(Modifier.height(3.dp))
                Text(
                    "Past ${Limits.formatAudioSeconds(paused.allowed)} of transcription this month, Murmur inserts your words with rule-based cleanup only (fair use). Nothing else changes.",
                    style = Murmur.type.bodySmall,
                    color = c.inkSoft
                )
            }
        }
        if (inference.meters.isNotEmpty()) {
            for (meter in inference.meters) MeterRow(meter)
            if (!inference.routing.murmurStt) {
                Text(
                    "This phone uses your own speech provider; only devices on Murmur's models count here.",
                    style = Murmur.type.labelSmall,
                    color = c.inkMuted,
                    modifier = Modifier.padding(bottom = Space.row)
                )
            }
        } else if (inference.status != null && inference.minutesLabel != null) {
            ControlRow(
                "Used this month",
                description = if (inference.routing.murmurStt) "Murmur's speech model is in use on this phone." else "This phone uses your own provider; the allowance is untouched by it."
            ) {
                Text(inference.minutesLabel ?: "", style = Murmur.type.labelSmall, color = c.inkSoft)
            }
        }
        if (upgrade != null || (inference.planState == "pro" && inference.accountUrl != null)) {
            Row(Modifier.padding(top = 4.dp, bottom = Space.row), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                if (upgrade != null) PrimaryButton("Upgrade", onClick = { open(upgrade) })
                else SecondaryButton("Manage plan", onClick = { open(inference.accountUrl) })
            }
        }
    }
}

/** One allowance: a track that fills as it is used, the figure, and when it resets. */
@Composable
private fun MeterRow(meter: UsageMeterDto) {
    val c = Murmur.colors
    val share = if (meter.allowed > 0) (meter.used / meter.allowed).coerceIn(0.0, 1.0).toFloat() else 0f
    val reset = Limits.formatResetTime(meter.resetsAt.toLong())
    Column(Modifier.fillMaxWidth().padding(vertical = Space.row)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(Limits.meterLabel(meter.limit), style = Murmur.type.title, color = c.ink, modifier = Modifier.weight(1f))
            Text(Limits.meterValue(meter), style = Murmur.type.labelSmall, color = c.inkSoft)
        }
        Spacer(Modifier.height(8.dp))
        Box(
            Modifier
                .fillMaxWidth()
                .height(6.dp)
                .clip(CircleShape)
                .background(c.hairline.copy(alpha = 0.6f))
        ) {
            Box(
                Modifier
                    .fillMaxWidth(maxOf(0.02f, share))
                    .fillMaxHeight()
                    .background(
                        when {
                            meter.exceeded -> c.ember
                            share >= 0.9f -> c.clay
                            else -> c.ink
                        },
                        CircleShape
                    )
            )
        }
        Spacer(Modifier.height(6.dp))
        Text(
            if (meter.exceeded) "Used up · more $reset" else "Resets ${reset.removePrefix("on ")}",
            style = Murmur.type.labelSmall,
            color = c.inkSoft
        )
    }
}
