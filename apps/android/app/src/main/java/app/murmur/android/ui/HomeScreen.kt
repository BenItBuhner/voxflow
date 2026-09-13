package app.murmur.android.ui

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import app.murmur.android.BuildConfig
import app.murmur.android.cloud.CloudConfig
import app.murmur.android.cloud.SyncStatus
import app.murmur.android.dictation.DictationController
import app.murmur.android.dictation.DictationState
import app.murmur.android.history.HistoryStore
import app.murmur.android.inference.Limits
import app.murmur.android.settings.DictationStats
import app.murmur.android.settings.MurmurSettings
import app.murmur.android.ui.components.Appear
import app.murmur.android.ui.components.AttentionCard
import app.murmur.android.ui.components.CountUp
import app.murmur.android.ui.components.Dot
import app.murmur.android.ui.components.EmptyFigure
import app.murmur.android.ui.components.Card
import app.murmur.android.ui.components.Glyph
import app.murmur.android.ui.components.LatencyBar
import app.murmur.android.ui.components.ListCard
import app.murmur.android.ui.components.Overline
import app.murmur.android.ui.components.PageMargin
import app.murmur.android.ui.components.RecentRow
import app.murmur.android.ui.components.Reveal
import app.murmur.android.ui.components.RollingText
import app.murmur.android.ui.components.StatTile
import app.murmur.android.ui.components.TextLink
import app.murmur.android.ui.components.Wordmark
import app.murmur.android.ui.theme.Murmur
import app.murmur.android.ui.theme.Radii
import app.murmur.android.ui.theme.Space
import app.murmur.android.update.UpdateManager
import app.murmur.android.update.UpdatePhase

/** How many recent dictations the home screen lists before pointing at History. */
private const val RECENT = 5

/**
 * The dashboard: a greeting, whatever still needs attention, the numbers (words, pace, time saved,
 * streak), a few things worth knowing, the live button, the latest dictations and where their time
 * went. The sections themselves live in the drawer behind the button at the top left.
 */
@Composable
fun HomeScreen(
    config: CloudConfig,
    settings: MurmurSettings,
    signedIn: Boolean,
    firstName: String?,
    syncStatus: SyncStatus?,
    nav: TopNav,
    onOpen: (Route) -> Unit
) {
    val c = Murmur.colors
    val context = LocalContext.current
    val permissions = rememberPermissionState()
    val dictation by DictationController.state.collectAsState()
    val updateState by UpdateManager.get(context).state.collectAsState()
    val history by HistoryStore.get(context).entries.collectAsState()
    val inference = rememberInferenceView(settings)
    val modelReady = inference.sttReady
    val ready = permissions.allGranted && modelReady
    // Murmur models only need a signed-in account; the user's own provider needs the model screen.
    val modelRoute = if (inference.routing.murmurStt) Route.ACCOUNT else Route.MODEL
    val greeting = remember { greetingFor() }
    // Signed in, the account's totals stand for every device; otherwise this phone's own.
    val stats = if (signedIn) syncStatus?.stats ?: settings.stats else settings.stats
    val recent = remember(history) { history.take(RECENT) }
    val last = remember(history) { lastSuccessful(history) }
    val insights = remember(history) { insightLines(history, daySummary(history, DictationStats.localDay(System.currentTimeMillis()))) }
    val updateReady = updateState.phase == UpdatePhase.READY

    Column(
        Modifier
            .fillMaxSize()
            .background(c.paper)
            .statusBarsPadding()
            .verticalScroll(rememberScrollState())
            .navigationBarsPadding()
    ) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = PageMargin - 10.dp).height(64.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            TopNavButton(nav)
            Spacer(Modifier.width(6.dp))
            Wordmark()
            Spacer(Modifier.weight(1f))
            StatusLine(dictation, ready, onClick = { onOpen(if (!permissions.allGranted) Route.PERMISSIONS else modelRoute) })
        }

        Column(Modifier.padding(horizontal = PageMargin)) {
            Reveal(0) {
                Column {
                    Spacer(Modifier.height(16.dp))
                    Text(
                        "$greeting${firstName?.let { ", $it" } ?: ""}.",
                        style = Murmur.type.displayMedium,
                        color = c.ink
                    )
                    Spacer(Modifier.height(10.dp))
                    Text(
                        "Tap the button beside your keyboard, speak, and finished text lands where your cursor is.",
                        style = Murmur.type.body,
                        color = c.inkSoft
                    )
                    planLine(inference)?.let { line ->
                        Spacer(Modifier.height(10.dp))
                        TextLink(line, onClick = { onOpen(Route.ACCOUNT) }, modifier = Modifier.offset(x = (-6).dp))
                    }
                    Spacer(Modifier.height(24.dp))
                }
            }

            Appear(!modelReady) {
                Column {
                    if (inference.routing.murmurStt) {
                        AttentionCard(
                            "Sign in to use Murmur's speech model",
                            "Your account includes speech and formatting models. Or connect your own provider under Speech model.",
                            onClick = { onOpen(modelRoute) }
                        )
                    } else {
                        AttentionCard(
                            "Connect a speech model",
                            "Murmur needs a transcription endpoint: OpenAI, Groq, Deepgram, or a local whisper server.",
                            onClick = { onOpen(modelRoute) }
                        )
                    }
                    Spacer(Modifier.height(12.dp))
                }
            }
            Appear(!permissions.allGranted) {
                Column {
                    AttentionCard(
                        if (permissions.total - permissions.granted == 1) "One permission to go" else "${permissions.total - permissions.granted} permissions to go",
                        "The microphone, drawing the button and typing for you each need a system grant.",
                        onClick = { onOpen(Route.PERMISSIONS) }
                    )
                    Spacer(Modifier.height(12.dp))
                }
            }
            Appear(updateReady) {
                Column {
                    AttentionCard(
                        "Version ${updateState.release?.version ?: ""} is ready".trim(),
                        "Downloaded and checked; it installs the next time nothing is being dictated.",
                        onClick = { onOpen(Route.UPDATES) }
                    )
                    Spacer(Modifier.height(12.dp))
                }
            }

            Reveal(1) {
                Column {
                    Spacer(Modifier.height(12.dp))
                    StatsGrid(stats)
                }
            }

            Appear(insights.isNotEmpty()) {
                Column {
                    Spacer(Modifier.height(28.dp))
                    Overline("Worth knowing")
                    Spacer(Modifier.height(10.dp))
                    Card(padding = PaddingValues(horizontal = Space.card, vertical = Space.sm)) {
                        for (line in insights) {
                            Text(line, style = Murmur.type.body, color = c.ink, modifier = Modifier.padding(vertical = 9.dp))
                        }
                    }
                }
            }

            Reveal(2) {
                Column {
                    Spacer(Modifier.height(36.dp))
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Overline("Your button")
                        Spacer(Modifier.weight(1f))
                        TextLink("Adjust", onClick = { onOpen(Route.BUTTON) })
                    }
                    Spacer(Modifier.height(10.dp))
                    PillPreview(settings, height = 128.dp)
                }
            }

            Reveal(3) {
                Column {
                    Spacer(Modifier.height(36.dp))
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Overline("Recent")
                        Spacer(Modifier.weight(1f))
                        if (history.isNotEmpty()) TextLink("View all", onClick = { onOpen(Route.HISTORY) })
                    }
                    Spacer(Modifier.height(10.dp))
                    if (recent.isEmpty()) {
                        EmptyRecent(onTry = { onOpen(Route.TRY_IT) })
                    } else {
                        ListCard {
                            for (entry in recent) RecentRow(entry, onClick = { onOpen(Route.HISTORY) })
                        }
                    }
                }
            }

            Appear(last != null) {
                Column {
                    Spacer(Modifier.height(36.dp))
                    Overline("Last dictation, where the time went")
                    Spacer(Modifier.height(10.dp))
                    Card { last?.let { LatencyBar(it.timings) } }
                }
            }

            Spacer(Modifier.height(44.dp))
            Text("Murmur ${BuildConfig.VERSION_NAME}", style = Murmur.type.labelSmall, color = c.inkMuted)
            Spacer(Modifier.height(28.dp))
        }
    }
}

/**
 * Where the account stands, in one quiet line under the greeting: the trial's days, the free week's
 * words, a paused formatting model. Null when there is nothing to say; never a banner.
 */
fun planLine(inference: InferenceView, now: Long = System.currentTimeMillis()): String? {
    if (!inference.offersMurmur || !inference.signedIn || inference.status == null) return null
    if (!inference.routing.murmurStt && inference.planState != "trial") return null
    return when (inference.planState) {
        "trial" -> "Pro trial · ${if (inference.trialDaysLeft == 1) "last day" else "${inference.trialDaysLeft} days left"}"
        "free" -> inference.meters.firstOrNull { it.limit == "wordsPerWeek" }?.let { words ->
            if (words.exceeded) "Free plan · this week's words are used up · more ${Limits.formatResetTime(words.resetsAt.toLong(), now)}"
            else "Free plan · ${Limits.meterValue(words)} this week"
        }
        else -> if (inference.formattingPaused) {
            val paused = inference.meters.firstOrNull { it.limit == "fairUseSttSecondsPerMonth" }
            "Pro · formatting paused${paused?.let { " until ${Limits.formatResetTime(it.resetsAt.toLong(), now).removePrefix("on ")}" } ?: ""} (fair use)"
        } else null
    }
}

/** Words, pace, time saved and streak, two by two, counting up as they arrive. */
@Composable
private fun StatsGrid(stats: DictationStats) {
    val wpm = wordsPerMinute(stats)
    val savedSec = (timeSavedMs(stats) / 1000).toInt()
    // Tiles in a row share the taller one's height, so a wrapped label never leaves a step.
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Row(Modifier.height(IntrinsicSize.Max), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            val tile = Modifier.weight(1f).fillMaxHeight()
            StatTile(Glyph.WORDS, "Words dictated", tile, hint = if (stats.isEmpty) "Nothing yet" else pluralize(stats.totalSessions, "dictation")) {
                CountUp(stats.totalWords, format = ::formatCount)
            }
            StatTile(Glyph.PACE, "Speaking pace", tile, hint = if (wpm > 0) "vs ~$TYPING_WPM typing" else null) {
                if (wpm > 0) CountUp(wpm, format = { "$it wpm" }) else EmptyFigure()
            }
        }
        Row(Modifier.height(IntrinsicSize.Max), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            val tile = Modifier.weight(1f).fillMaxHeight()
            StatTile(Glyph.TIME, "Time saved", tile, hint = if (savedSec > 0) "over typing it out" else null) {
                if (savedSec > 0) CountUp(savedSec, format = { formatDurationShort(it * 1000L) }) else EmptyFigure()
            }
            StatTile(Glyph.STREAK, "Day streak", tile, hint = if (stats.streakDays > 0) "dictated every day" else null) {
                if (stats.streakDays > 0) CountUp(stats.streakDays) else EmptyFigure()
            }
        }
    }
}

/** Nothing dictated yet: a well where the list will be. */
@Composable
private fun EmptyRecent(onTry: () -> Unit) {
    val c = Murmur.colors
    Column(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(Radii.card))
            .background(c.paperRaised)
            .padding(horizontal = Space.card, vertical = 26.dp),
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        Text(
            "Nothing yet. Your dictations show up here with their timing breakdown.",
            style = Murmur.type.bodySmall,
            color = c.inkSoft
        )
        Spacer(Modifier.height(8.dp))
        TextLink("Try it now", onClick = onTry, color = c.ink)
    }
}

/** Live state in the corner: what the button is doing right now, or that setup is unfinished. */
@Composable
private fun StatusLine(state: DictationState, ready: Boolean, onClick: () -> Unit) {
    val c = Murmur.colors
    val (label, target, pulsing) = when {
        state is DictationState.Listening -> Triple("Listening", c.ember, true)
        state is DictationState.Processing -> Triple("Working", c.ember, true)
        !ready -> Triple("Setup", c.ember, false)
        else -> Triple("Ready", c.sage, false)
    }
    val color by animateColorAsState(target, tween(260), label = "status")
    Row(
        Modifier
            .clip(CircleShape)
            .clickable(enabled = !ready, onClick = onClick)
            .padding(horizontal = 10.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Dot(color, size = 7.dp, pulsing = pulsing)
        Spacer(Modifier.width(9.dp))
        RollingText(label.uppercase(), style = Murmur.type.overline, color = if (ready) c.inkSoft else c.ink)
    }
}
