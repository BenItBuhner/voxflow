import { SttError, combineSignals, errorFromResponse, toSttError, type SttConfig } from '@core/stt'
import { formatTranscript, type FormatInput, type FormatResult } from '@engine'
import {
  chatComplete,
  type ChatMessage,
  type ChatOptions,
  type ChatResult,
  type Complete,
  type LlmConfig
} from '@core/llm/client'
import type { CloudConfig } from '@shared/cloud'
import { parseLimitNotice, type LimitNotice } from '@shared/limits'
import {
  MURMUR_LLM_MODEL,
  MURMUR_PROVIDER,
  MURMUR_STT_MODEL,
  murmurGatewayUrl,
  resolveInferenceSources,
  type InferenceRouting,
  type InferenceSource
} from '@shared/inference'
import type { Settings, SttProviderKind } from '@shared/settings'
import { createLogger } from '../logger'

const log = createLogger('inference')

/** The slice of the settings store the router needs; structural so tests can pass a stub. */
export interface RouterSettings {
  get(): Settings
  getSecret(slot: 'stt' | 'llm'): string
}

export interface RouterDeps {
  config: CloudConfig
  settings: RouterSettings
  /** Convex JWT for the signed-in account (from the renderer's Clerk session), or null. */
  token: (forceRefresh: boolean) => Promise<string | null>
  /** What the renderer last reported about the session; explains a missing token. */
  signedIn: () => boolean
  /** Whether the instance offers managed models, once the account status has arrived. */
  managedAvailable: () => boolean | undefined
}

export interface ResolvedStt {
  source: InferenceSource
  cfg: SttConfig
  /** Tried when the primary model errors (custom providers only). */
  fallbackModel: string
  /** `provider` for history entries: the provider kind, or `murmur`. */
  provider: SttProviderKind | typeof MURMUR_PROVIDER
}

export interface ResolvedLlm {
  source: InferenceSource
  cfg: LlmConfig
}

/**
 * Decides, for every request, whether speech-to-text and formatting go to the models the Murmur
 * instance provides or to the provider the user configured, and builds the matching client
 * configuration. Murmur-bound configurations carry the account's short-lived session token as the
 * API key, so they are resolved per request and refreshed when the gateway rejects one.
 *
 * In local builds there is no instance: everything resolves to the user's own provider and no
 * Murmur endpoint is ever contacted.
 */
/**
 * The engine's result, plus the plan limit a Murmur instance applied when it answered with
 * rule-based text instead of asking the model (a Pro account past its fair-use cap).
 */
export interface FormatOutcome extends FormatResult {
  limit?: LimitNotice
}

export interface Formatter {
  source: InferenceSource
  format: (input: FormatInput) => Promise<FormatOutcome>
}

export class InferenceRouter {
  constructor(private readonly deps: RouterDeps) {}

  get cloudEnabled(): boolean {
    return this.deps.config.accountMode !== 'off' && !!this.deps.config.convexSiteUrl
  }

  routing(): InferenceRouting {
    return resolveInferenceSources(this.deps.settings.get(), {
      cloudEnabled: this.cloudEnabled,
      managedAvailable: this.deps.managedAvailable()
    })
  }

  private get gatewayUrl(): string {
    return murmurGatewayUrl(this.deps.config.convexSiteUrl)
  }

  /** True for a configuration that points at this instance's gateway. */
  isMurmur(cfg: { baseUrl: string }): boolean {
    return this.cloudEnabled && cfg.baseUrl.replace(/\/+$/, '') === this.gatewayUrl
  }

  private async sessionToken(forceRefresh: boolean): Promise<string> {
    const token = await this.deps.token(forceRefresh)
    if (token) return token
    if (!this.deps.signedIn()) {
      throw new SttError(
        'Sign in to use Murmur models, or choose your own provider under Models',
        'auth',
        undefined,
        [],
        'murmur_signed_out'
      )
    }
    throw new SttError(
      'Could not get a session token for Murmur models; check your connection and try again',
      'network',
      undefined,
      [],
      'murmur_no_token'
    )
  }

  async stt(opts: { forceRefresh?: boolean } = {}): Promise<ResolvedStt> {
    const s = this.deps.settings.get()
    if (this.routing().stt === 'murmur') {
      return {
        source: 'murmur',
        cfg: {
          kind: 'openai-compatible',
          baseUrl: this.gatewayUrl,
          apiKey: await this.sessionToken(!!opts.forceRefresh),
          model: MURMUR_STT_MODEL,
          language: s.stt.language,
          timeoutMs: s.stt.timeoutMs
        },
        fallbackModel: '',
        provider: MURMUR_PROVIDER
      }
    }
    return {
      source: 'custom',
      cfg: {
        kind: s.stt.kind,
        baseUrl: s.stt.baseUrl,
        apiKey: this.deps.settings.getSecret('stt'),
        model: s.stt.model,
        language: s.stt.language,
        timeoutMs: s.stt.timeoutMs
      },
      fallbackModel: s.stt.fallbackModel,
      provider: s.stt.kind
    }
  }

  async llm(opts: { forceRefresh?: boolean } = {}): Promise<ResolvedLlm> {
    const s = this.deps.settings.get()
    const llm = s.formatting.llm
    if (this.routing().llm === 'murmur') {
      return {
        source: 'murmur',
        cfg: {
          baseUrl: this.gatewayUrl,
          apiKey: await this.sessionToken(!!opts.forceRefresh),
          model: MURMUR_LLM_MODEL,
          timeoutMs: llm.timeoutMs
        }
      }
    }
    const stt = llm.sameAsStt
    return {
      source: 'custom',
      cfg: {
        baseUrl: stt ? s.stt.baseUrl : llm.baseUrl,
        apiKey: this.deps.settings.getSecret(stt ? 'stt' : 'llm'),
        model: llm.model,
        timeoutMs: llm.timeoutMs
      }
    }
  }

  /**
   * Chat completion that survives an expired session token: a 401 from the gateway is answered by
   * fetching a fresh token and retrying once. Drop-in for `smartFormat`'s `complete` parameter.
   */
  readonly complete: Complete = async (
    cfg: LlmConfig,
    messages: ChatMessage[],
    opts?: ChatOptions
  ): Promise<ChatResult> => {
    try {
      return await chatComplete(cfg, messages, opts)
    } catch (err) {
      if (!(err instanceof SttError) || err.kind !== 'auth' || !this.isMurmur(cfg)) throw err
      log.info('session token rejected by the gateway; refreshing and retrying')
      const fresh = await this.sessionToken(true)
      return await chatComplete({ ...cfg, apiKey: fresh }, messages, opts)
    }
  }

  /**
   * The formatting stage for the current routing. Against a Murmur instance the whole engine
   * (prompt, verifier, retry, fallback) runs on the gateway's `POST /v1/format`, so both apps
   * share one implementation and the instance can tune it; with the user's own provider the same
   * engine runs here, with the model call going to that provider.
   */
  async formatter(): Promise<Formatter> {
    const resolved = await this.llm()
    const cfg = resolved.cfg
    if (resolved.source === 'murmur') {
      return {
        source: 'murmur',
        format: (input) => this.remoteFormat(cfg, input)
      }
    }
    if (!cfg.baseUrl || !cfg.model)
      return { source: 'custom', format: (input) => formatTranscript(input, null) }
    return {
      source: 'custom',
      format: (input) =>
        formatTranscript(input, (messages, opts) => this.complete(cfg, messages, opts))
    }
  }

  private async remoteFormat(cfg: LlmConfig, input: FormatInput): Promise<FormatOutcome> {
    const call = async (apiKey: string): Promise<FormatOutcome> => {
      let res: Response
      try {
        res = await fetch(`${cfg.baseUrl}/format`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ transcript: input.transcript, context: input.context }),
          // The gateway may make two model round trips before answering.
          signal: combineSignals(cfg.timeoutMs * 2 + 2000)
        })
      } catch (err) {
        throw toSttError(err, 'Formatting request failed')
      }
      if (!res.ok) throw errorFromResponse(res.status, await res.text())
      const json = (await res.json()) as FormatResult & { limit?: unknown }
      const limit = parseLimitNotice(json.limit, json.status?.detail)
      return { ...json, limit: limit ?? undefined }
    }
    try {
      return await call(cfg.apiKey)
    } catch (err) {
      if (!(err instanceof SttError) || err.kind !== 'auth') throw err
      log.info('session token rejected by the gateway; refreshing and retrying')
      return await call(await this.sessionToken(true))
    }
  }

  /** Same recovery for a speech request: returns the retry configuration, or null when not applicable. */
  async refreshedStt(resolved: ResolvedStt, err: unknown): Promise<SttConfig | null> {
    if (resolved.source !== 'murmur') return null
    if (!(err instanceof SttError) || err.kind !== 'auth') return null
    log.info('session token rejected by the gateway; refreshing and retrying')
    return { ...resolved.cfg, apiKey: await this.sessionToken(true) }
  }
}
