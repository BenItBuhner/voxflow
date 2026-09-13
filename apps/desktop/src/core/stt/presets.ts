import type { SttProviderKind } from '@shared/settings'

export interface SttPreset {
  id: string
  name: string
  kind: SttProviderKind
  baseUrl: string
  defaultModel: string
  /** Known model ids shown before discovery; discovery results replace them when available. */
  models: string[]
  requiresKey: boolean
  local?: boolean
  docsUrl?: string
  note?: string
  /** Whether the /models endpoint is expected to work. */
  supportsDiscovery: boolean
}

export const STT_PRESETS: SttPreset[] = [
  {
    id: 'custom',
    name: 'Custom (OpenAI-compatible)',
    kind: 'openai-compatible',
    baseUrl: '',
    defaultModel: 'whisper-1',
    models: ['whisper-1'],
    requiresKey: false,
    supportsDiscovery: true,
    note: 'Any server that implements POST /v1/audio/transcriptions: proxies, LiteLLM, LocalAI, vLLM, Speaches, etc.'
  },
  {
    id: 'openai',
    name: 'OpenAI',
    kind: 'openai-compatible',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini-transcribe',
    models: ['gpt-4o-mini-transcribe', 'gpt-4o-transcribe', 'whisper-1'],
    requiresKey: true,
    supportsDiscovery: true,
    docsUrl: 'https://platform.openai.com/docs/guides/speech-to-text'
  },
  {
    id: 'groq',
    name: 'Groq',
    kind: 'openai-compatible',
    baseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: 'whisper-large-v3-turbo',
    // distil-whisper-large-v3-en was retired on 2025-08-23 in favour of whisper-large-v3-turbo.
    models: ['whisper-large-v3-turbo', 'whisper-large-v3'],
    requiresKey: true,
    supportsDiscovery: true,
    docsUrl: 'https://console.groq.com/docs/speech-to-text',
    note: 'Fastest hosted Whisper; whisper-large-v3-turbo usually returns in well under a second.'
  },
  {
    id: 'mistral',
    name: 'Mistral (Voxtral)',
    kind: 'openai-compatible',
    baseUrl: 'https://api.mistral.ai/v1',
    defaultModel: 'voxtral-mini-latest',
    models: ['voxtral-mini-latest', 'voxtral-small-latest'],
    requiresKey: true,
    supportsDiscovery: true,
    docsUrl: 'https://docs.mistral.ai/capabilities/audio/'
  },
  {
    id: 'deepgram',
    name: 'Deepgram',
    kind: 'deepgram',
    baseUrl: 'https://api.deepgram.com/v1',
    defaultModel: 'nova-3',
    models: ['nova-3', 'nova-2', 'nova-3-medical'],
    requiresKey: true,
    supportsDiscovery: true,
    docsUrl: 'https://developers.deepgram.com/docs/pre-recorded-audio',
    note: 'Dictionary terms are sent as keyterm boosts.'
  },
  {
    id: 'elevenlabs',
    name: 'ElevenLabs Scribe',
    kind: 'elevenlabs',
    baseUrl: 'https://api.elevenlabs.io/v1',
    defaultModel: 'scribe_v1',
    models: ['scribe_v1', 'scribe_v1_experimental'],
    requiresKey: true,
    supportsDiscovery: false,
    docsUrl: 'https://elevenlabs.io/docs/capabilities/speech-to-text'
  },
  {
    id: 'whisper-cpp',
    name: 'Local: whisper.cpp server',
    kind: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:8080/v1',
    defaultModel: 'whisper-1',
    models: ['whisper-1'],
    requiresKey: false,
    local: true,
    supportsDiscovery: false,
    docsUrl: 'https://github.com/ggml-org/whisper.cpp/tree/master/examples/server',
    note: 'Run `whisper-server -m ggml-base.en.bin --port 8080`. The model field is ignored by the server.'
  },
  {
    id: 'speaches',
    name: 'Local: Speaches / faster-whisper-server',
    kind: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:8000/v1',
    defaultModel: 'Systran/faster-whisper-large-v3',
    models: [
      'Systran/faster-whisper-large-v3',
      'Systran/faster-distil-whisper-large-v3',
      'Systran/faster-whisper-small'
    ],
    requiresKey: false,
    local: true,
    supportsDiscovery: true,
    docsUrl: 'https://speaches.ai/'
  },
  {
    id: 'lm-studio',
    name: 'Local: LM Studio / LocalAI / vLLM',
    kind: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:1234/v1',
    defaultModel: 'whisper-1',
    models: ['whisper-1'],
    requiresKey: false,
    local: true,
    supportsDiscovery: true
  }
]

export function findPreset(id: string): SttPreset {
  return STT_PRESETS.find((p) => p.id === id) ?? STT_PRESETS[0]
}

export interface LlmPreset {
  id: string
  name: string
  baseUrl: string
  defaultModel: string
  models: string[]
}

export const LLM_PRESETS: LlmPreset[] = [
  { id: 'same', name: 'Same server as speech-to-text', baseUrl: '', defaultModel: '', models: [] },
  {
    id: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    // gpt-4.1-nano shuts down on 2026-10-23; OpenAI recommends gpt-5.6-luna in its place.
    models: ['gpt-4o-mini', 'gpt-4.1-mini', 'gpt-5.6-luna']
  },
  {
    id: 'groq',
    name: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    // llama-3.1-8b-instant and llama-3.3-70b-versatile were retired for the free and developer
    // tiers on 2026-08-16; these are Groq's recommended replacements (shared/models.ts).
    defaultModel: 'openai/gpt-oss-20b',
    models: ['openai/gpt-oss-20b', 'openai/gpt-oss-120b']
  },
  {
    id: 'ollama',
    name: 'Local: Ollama',
    baseUrl: 'http://127.0.0.1:11434/v1',
    defaultModel: 'llama3.2',
    models: ['llama3.2', 'qwen2.5:7b']
  },
  { id: 'custom', name: 'Custom (OpenAI-compatible)', baseUrl: '', defaultModel: '', models: [] }
]
