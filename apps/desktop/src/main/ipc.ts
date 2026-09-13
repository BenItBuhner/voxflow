import { readFileSync } from 'node:fs'
import { app, ipcMain, shell, BrowserWindow } from 'electron'
import { getSttProvider, STT_PRESETS, type SttConfig } from '@core/stt'
import { listChatModels, type LlmConfig } from '@core/llm/client'
import {
  basicCleanup,
  buildSttPrompt,
  classifyApp,
  countWords,
  finish,
  formatTranscript,
  prepareTranscript,
  resolveStyle,
  type FormatResult
} from '@engine'
import { IPC, type RecordingsInfo, type RetryResult, type ThemeReport } from '@shared/ipc'
import type { Settings } from '@shared/settings'
import { isHexColor } from '@shared/theme'
import type { CloudConfig, RendererAuthState, SyncStatus } from '@shared/cloud'
import type {
  AppInfo,
  HistoryEntry,
  PreviewRequest,
  PreviewResult,
  ProviderTestResult
} from '@shared/types'
import type { UpdateStatus } from '@shared/updates'
import fixtureWav from '../../resources/fixtures/jfk.wav?asset'
import type { CloudSync } from './cloud/sync-engine'
import type { DictationController } from './dictation/session'
import { friendlyError } from './dictation/session'
import type { HookService } from './hotkeys/hook'
import type { InferenceRouter } from './inference/router'
import { injectText, injectionBackendName } from './inject'
import { sessionType } from './inject/linux'
import { createLogger, getLogPath } from './logger'
import type { SettingsStore, SettingsPatch } from './store/settings'
import type { HistoryStore } from './store/history'
import type { RecordingStore } from './store/recordings'
import type { UpdateService } from './update/service'
import { releasesPageUrl, type UpdateSource } from './update/source'
import { showMainWindow, updateChrome } from './windows/main-window'
import type { OverlayWindow } from './windows/overlay'

const log = createLogger('ipc')

export interface IpcDeps {
  settings: SettingsStore
  history: HistoryStore
  recordings: RecordingStore
  controller: DictationController
  overlay: OverlayWindow
  hook: HookService
  inference: InferenceRouter
  cloudConfig: CloudConfig
  cloud: CloudSync
  updates: UpdateService
  updateSource: UpdateSource
  /** Current OS accent colour (`#rrggbb`) or null. */
  systemAccent: () => string | null
  onEnabledChange: (enabled: boolean) => void
  quit: () => void
}

function broadcast(channel: string, payload: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, payload)
  }
}

export function registerIpc(deps: IpcDeps): void {
  const {
    settings,
    history,
    recordings,
    controller,
    overlay,
    hook,
    inference,
    cloud,
    cloudConfig,
    updates
  } = deps

  settings.on('change', (next: Settings) => broadcast(IPC.settingsChanged, next))
  history.on('added', (entry: HistoryEntry) => broadcast(IPC.historyAdded, entry))
  history.on('changed', () => broadcast(IPC.historyChanged, undefined))
  hook.on('capture', (c) => broadcast(IPC.hotkeyCaptured, { ...c, final: false }))
  hook.on('captured', (c) => broadcast(IPC.hotkeyCaptured, { ...c, final: true }))
  cloud.on('status', (status: SyncStatus) => broadcast(IPC.cloudStatusChanged, status))
  updates.on('status', (status: UpdateStatus) => broadcast(IPC.updatesStatusChanged, status))

  ipcMain.handle(IPC.updatesStatus, (): UpdateStatus => updates.getStatus())
  ipcMain.handle(IPC.updatesCheck, () => updates.check({ manual: true }))
  ipcMain.handle(IPC.updatesDownload, () => updates.download())
  ipcMain.handle(IPC.updatesCancelDownload, () => updates.cancelDownload())
  ipcMain.handle(IPC.updatesInstall, () => updates.install())
  ipcMain.handle(IPC.updatesSkip, () => updates.skip())
  ipcMain.handle(IPC.updatesAckUpdated, () => updates.ackUpdated())
  ipcMain.handle(IPC.updatesReveal, () => {
    const path = updates.getStatus().downloadedPath
    if (path) shell.showItemInFolder(path)
  })
  ipcMain.handle(IPC.updatesOpenReleases, () => {
    const release = updates.getStatus().release
    void shell.openExternal(release?.url ?? releasesPageUrl(deps.updateSource))
  })

  ipcMain.handle(IPC.cloudConfig, (): CloudConfig => cloudConfig)
  ipcMain.handle(IPC.cloudStatus, (): SyncStatus => cloud.getStatus())
  ipcMain.handle(IPC.cloudAuthState, (_e, state: RendererAuthState) => {
    cloud.setAuthState(state)
    return cloud.getStatus()
  })
  ipcMain.handle(IPC.cloudSyncNow, () => cloud.syncNow())
  ipcMain.handle(IPC.cloudRemoveDevice, async (_e, deviceId: string) => {
    try {
      return { ok: await cloud.removeDevice(deviceId) }
    } catch (err) {
      return { ok: false, error: friendlyError(err) }
    }
  })
  ipcMain.handle(IPC.cloudDeleteData, async () => {
    try {
      await cloud.deleteMyData()
      return { ok: true }
    } catch (err) {
      return { ok: false, error: friendlyError(err) }
    }
  })
  ipcMain.handle(IPC.cloudSetHistorySync, (_e, enabled: boolean) => cloud.setHistorySync(!!enabled))
  ipcMain.handle(IPC.cloudSkipAccount, () => {
    if (cloudConfig.accountMode !== 'optional') return false
    settings.patch({ cloud: { accountSkipped: true } })
    return true
  })

  ipcMain.handle(IPC.themeSystemAccent, () => deps.systemAccent())
  ipcMain.handle(IPC.themeReport, (_e, report: ThemeReport) => {
    if (isHexColor(report?.background) && isHexColor(report?.foreground)) {
      updateChrome({ background: report.background, foreground: report.foreground })
    }
  })

  ipcMain.handle(IPC.settingsGet, () => settings.get())
  ipcMain.handle(IPC.settingsPatch, (_e, patch: SettingsPatch) => settings.patch(patch))
  ipcMain.handle(IPC.settingsReset, () => settings.reset())
  ipcMain.handle(IPC.secretSet, (_e, slot: 'stt' | 'llm', value: string) => {
    settings.setSecret(slot, value)
    return true
  })
  ipcMain.handle(IPC.secretHas, (_e, slot: 'stt' | 'llm') => settings.hasSecret(slot))

  ipcMain.handle(IPC.historyList, (_e, limit?: number, offset?: number) =>
    history.list(limit, offset)
  )
  ipcMain.handle(IPC.historyDelete, (_e, id: string) => history.delete(id))
  ipcMain.handle(IPC.historyClear, () => history.clear())
  ipcMain.handle(IPC.historyReinsert, async (_e, id: string) => {
    const entry = history.get(id)
    if (!entry) return { ok: false, error: 'Entry not found' }
    const s = settings.get()
    // Give the user a moment to focus the target window after clicking.
    await new Promise((r) => setTimeout(r, 900))
    return injectText(entry.finalText + (s.formatting.trailingSpace ? ' ' : ''), {
      method: s.injection.method,
      restoreClipboard: s.injection.restoreClipboard,
      restoreClipboardDelayMs: s.injection.restoreClipboardDelayMs,
      typeChunkSize: s.injection.typeChunkSize,
      typeChunkDelayMs: s.injection.typeChunkDelayMs,
      waitForKeysUp: () => hook.waitForKeysUp(1000)
    })
  })
  // From the History page the settings window is what has focus, so the result is only copied.
  ipcMain.handle(IPC.historyRetry, (_e, id: string): Promise<RetryResult> =>
    controller.retry(id, { inject: false })
  )
  ipcMain.handle(IPC.historyAudio, async (_e, id: string): Promise<Uint8Array | null> => {
    const entry = history.get(id)
    if (!entry || !recordings.has(entry.recording)) return null
    try {
      return await recordings.readBytes(entry.recording)
    } catch (err) {
      log.warn(`recording ${entry.recording} unreadable`, err)
      return null
    }
  })
  ipcMain.handle(IPC.recordingsInfo, (): RecordingsInfo => recordings.info())
  ipcMain.handle(IPC.recordingsClear, () => {
    history.stripRecordings()
    recordings.clear()
  })

  // The pill's own buttons: Retry sends the failed dictation's audio again into the field that is
  // still focused; the cross just waves the message away.
  ipcMain.on(IPC.overlayRetry, (_e, id: string) => {
    if (typeof id !== 'string') return
    void controller.retry(id, { inject: true })
  })
  ipcMain.on(IPC.overlayDismiss, () => overlay.dismiss())
  // The limit pill's ways forward. The message is waved away as the user acts on it: the account
  // page opens in the browser, or the Models page comes up to connect their own provider.
  ipcMain.on(IPC.overlayOpenUrl, (_e, url: string) => {
    if (typeof url !== 'string' || !/^https:\/\//.test(url)) return
    void shell.openExternal(url)
    overlay.dismiss()
  })
  ipcMain.on(IPC.overlayOpenModels, () => {
    showMainWindow('providers')
    overlay.dismiss()
  })

  /**
   * Speech configuration for the settings UI: the resolved connection (the instance's models or
   * the user's own provider) with any fields the page is trying out layered on top. Explicit
   * overrides describe the user's own provider, so they never point at the Murmur gateway.
   */
  const sttConfigFor = async (
    override:
      | { kind?: Settings['stt']['kind']; baseUrl?: string; apiKey?: string; model?: string }
      | undefined,
    timeoutMs: number
  ): Promise<SttConfig> => {
    const s = settings.get()
    if (override && (override.baseUrl !== undefined || override.kind !== undefined)) {
      return {
        kind: override.kind ?? s.stt.kind,
        baseUrl: override.baseUrl ?? s.stt.baseUrl,
        apiKey: override.apiKey ?? settings.getSecret('stt'),
        model: override.model ?? s.stt.model,
        language: s.stt.language,
        timeoutMs
      }
    }
    const { cfg } = await inference.stt()
    return { ...cfg, model: override?.model ?? cfg.model, timeoutMs }
  }

  const llmConfigFor = async (
    override: { baseUrl?: string; apiKey?: string; model?: string } | undefined,
    timeoutMs: number
  ): Promise<LlmConfig> => {
    if (override && override.baseUrl !== undefined) {
      const conn = settings.llmConnection()
      return {
        baseUrl: override.baseUrl,
        apiKey: override.apiKey ?? conn.apiKey,
        model: override.model ?? conn.model,
        timeoutMs
      }
    }
    const { cfg } = await inference.llm()
    return { ...cfg, model: override?.model ?? cfg.model, timeoutMs }
  }

  ipcMain.handle(
    IPC.sttListModels,
    async (
      _e,
      override?: { kind?: Settings['stt']['kind']; baseUrl?: string; apiKey?: string }
    ) => {
      try {
        const cfg = await sttConfigFor(override, 15000)
        return { ok: true, models: await getSttProvider(cfg.kind).listModels(cfg) }
      } catch (err) {
        return { ok: false, models: [], error: friendlyError(err) }
      }
    }
  )

  ipcMain.handle(
    IPC.sttTest,
    async (
      _e,
      override?: {
        kind?: Settings['stt']['kind']
        baseUrl?: string
        apiKey?: string
        model?: string
      }
    ): Promise<ProviderTestResult> => {
      try {
        const cfg = { ...(await sttConfigFor(override, 45000)), language: 'en' }
        const wav = new Uint8Array(readFileSync(fixtureWav))
        const res = await getSttProvider(cfg.kind).transcribe(
          { wav, prompt: buildSttPrompt([]) },
          cfg
        )
        const ok = /country/i.test(res.text)
        return {
          ok,
          latencyMs: res.latencyMs,
          text: res.text,
          message: ok
            ? `Transcribed the test clip in ${res.latencyMs} ms`
            : `Connected, but the transcript looks wrong: "${res.text.slice(0, 80)}"`
        }
      } catch (err) {
        const e = err as { suggestedModels?: string[] }
        return { ok: false, message: friendlyError(err), suggestedModels: e.suggestedModels ?? [] }
      }
    }
  )

  ipcMain.handle(
    IPC.llmListModels,
    async (_e, override?: { baseUrl?: string; apiKey?: string }) => {
      try {
        const cfg = await llmConfigFor(override, 15000)
        return { ok: true, models: await listChatModels(cfg) }
      } catch (err) {
        return { ok: false, models: [], error: friendlyError(err) }
      }
    }
  )

  ipcMain.handle(
    IPC.llmTest,
    async (
      _e,
      override?: { baseUrl?: string; apiKey?: string; model?: string }
    ): Promise<ProviderTestResult> => {
      try {
        const cfg = await llmConfigFor(override, 20000)
        const res = await inference.complete(
          cfg,
          [
            {
              role: 'system',
              content:
                "Rewrite the user's dictated text with correct punctuation and capitalization and without filler words. Output only the text."
            },
            { role: 'user', content: 'um so this is a quick test of the uh formatting model' }
          ],
          { maxTokens: 768 }
        )
        const ok = res.text.trim().length > 0 && !/\bum\b|\buh\b/i.test(res.text)
        return {
          ok,
          latencyMs: res.latencyMs,
          text: res.text.trim(),
          message: ok
            ? `Formatted in ${res.latencyMs} ms`
            : `Model answered but did not clean the text: "${res.text.trim().slice(0, 80)}"`
        }
      } catch (err) {
        const e = err as { suggestedModels?: string[] }
        return { ok: false, message: friendlyError(err), suggestedModels: e.suggestedModels ?? [] }
      }
    }
  )

  ipcMain.handle(IPC.hotkeyCaptureStart, () => hook.startCapture())
  ipcMain.handle(IPC.hotkeyCaptureStop, () => hook.stopCapture())
  ipcMain.handle(IPC.hotkeyLabel, (_e, keys: number[]) => hook.labelFor(keys))

  ipcMain.handle(IPC.dictationToggle, () => controller.toggle())
  ipcMain.handle(IPC.dictationCancel, () => controller.handle({ type: 'cancel' }))

  ipcMain.handle(IPC.appInfo, (): AppInfo => ({
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron,
    hookBackend: hook.backend,
    injectionBackend: injectionBackendName(),
    sessionType: process.platform === 'linux' ? sessionType() : undefined,
    installKind: updates.getStatus().installKind,
    userDataPath: app.getPath('userData'),
    logPath: getLogPath()
  }))
  ipcMain.handle(IPC.appOpenExternal, (_e, url: string) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
  })
  ipcMain.handle(IPC.appOpenLogs, () => shell.showItemInFolder(getLogPath()))
  ipcMain.handle(IPC.appSetEnabled, (_e, enabled: boolean) => deps.onEnabledChange(enabled))
  ipcMain.handle(IPC.appQuit, () => deps.quit())
  ipcMain.handle(IPC.onboardingComplete, () => {
    settings.patch({ onboardingComplete: true })
    cloud.completeOnboarding()
    showMainWindow('home')
  })

  ipcMain.handle(IPC.injectTest, async (_e, text: string) => {
    const s = settings.get()
    await new Promise((r) => setTimeout(r, 1200))
    return injectText(text, {
      method: s.injection.method,
      restoreClipboard: s.injection.restoreClipboard,
      restoreClipboardDelayMs: s.injection.restoreClipboardDelayMs,
      typeChunkSize: s.injection.typeChunkSize,
      typeChunkDelayMs: s.injection.typeChunkDelayMs,
      waitForKeysUp: () => hook.waitForKeysUp(1000)
    })
  })

  ipcMain.handle(
    IPC.pipelinePreview,
    async (_e, req: PreviewRequest | string): Promise<PreviewResult> => {
      const request: PreviewRequest = typeof req === 'string' ? { raw: req } : req
      const s = settings.get()
      const app = classifyApp(request.app ?? '', request.title ?? '')
      const style = resolveStyle(s.formatting, s.formatting.appRules, app)
      const finishOpts = {
        category: app.category,
        dictionary: s.dictionary,
        trailingSpace: false,
        snippets: s.snippets,
        snippetContext: { now: new Date() }
      }
      const prepared = prepareTranscript(request.raw)
      const light = basicCleanup(prepared.text, { dictionary: s.dictionary })
      const lightFinished = finish(light.text, finishOpts)
      const out: PreviewResult = {
        light: {
          text: lightFinished.text,
          stages: [...prepared.stages, ...light.stages, ...lightFinished.stages],
          wordCount: countWords(lightFinished.text),
          pressEnter: prepared.pressEnter
        },
        style: {
          category: app.category,
          ruleMatch: style.rule?.match,
          tone: style.tone,
          mode: style.mode
        }
      }
      if (request.smart) {
        const input = {
          transcript: request.raw,
          mode: 'smart' as const,
          context: controller.formatContext(s, style, app)
        }
        let formatted: FormatResult
        try {
          const formatter = await inference.formatter()
          formatted = await formatter.format(input)
        } catch (err) {
          formatted = await formatTranscript(input, null)
          formatted.status = { outcome: 'failed', detail: friendlyError(err), attempts: 0 }
        }
        const finished = finish(formatted.text, finishOpts)
        out.smart = {
          status: formatted.status,
          text: formatted.status.outcome === 'used' ? finished.text : undefined,
          modelText: formatted.modelText,
          llmMs: formatted.llmMs,
          stages: [...formatted.stages, ...finished.stages]
        }
      }
      return out
    }
  )

  ipcMain.handle(IPC.sttListModels + ':presets', () => STT_PRESETS)
}
