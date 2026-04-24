import type { ProviderConfig, ProviderKind } from './protocol.ts'
import { createProviderId } from './providerConfig.ts'

export interface ProviderPreset {
  /** Unique key for lookup and matching */
  key: string
  /** User-facing display name */
  name: string
  /** Default provider kind for the AI SDK wire */
  type: ProviderKind
  /** Default base URL (empty string for providers that don't use one, e.g. Vertex) */
  baseUrl: string
  /** Icon key for @lobehub/icons ProviderIcon */
  iconKey: string
}

/**
 * Alphabetically sorted predefined provider presets.
 * Each entry carries just enough info to pre-fill a new ProviderConfig.
 */
export const providerPresets: readonly ProviderPreset[] = [
  {
    key: 'aliyun-bailian',
    name: 'Aliyun Bailian',
    type: 'openai',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    iconKey: 'bailian'
  },
  {
    key: 'anthropic',
    name: 'Anthropic',
    type: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    iconKey: 'anthropic'
  },
  {
    key: 'deepseek',
    name: 'DeepSeek',
    type: 'anthropic',
    baseUrl: 'https://api.deepseek.com/anthropic',
    iconKey: 'deepseek'
  },
  {
    key: 'gemini',
    name: 'Gemini',
    type: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    iconKey: 'google'
  },
  {
    key: 'google-vertex',
    name: 'Google Vertex AI',
    type: 'vertex',
    baseUrl: '',
    iconKey: 'vertexai'
  },
  {
    key: 'kimi-coding',
    name: 'Kimi For Coding',
    type: 'anthropic',
    baseUrl: 'https://api.kimi.com/coding/v1',
    iconKey: 'kimicodingplan'
  },
  {
    key: 'minimax',
    name: 'Minimax',
    type: 'openai',
    baseUrl: 'https://api.minimaxi.com/v1',
    iconKey: 'minimax'
  },
  {
    key: 'mistral',
    name: 'Mistral',
    type: 'openai',
    baseUrl: 'https://api.mistral.ai/v1',
    iconKey: 'mistral'
  },
  {
    key: 'moonshot',
    name: 'Moonshot',
    type: 'openai',
    baseUrl: 'https://api.moonshot.cn/v1',
    iconKey: 'moonshot'
  },
  {
    key: 'ollama',
    name: 'Ollama',
    type: 'openai',
    baseUrl: 'http://localhost:11434/v1',
    iconKey: 'ollama'
  },
  {
    key: 'openai',
    name: 'OpenAI',
    type: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    iconKey: 'openai'
  },
  {
    key: 'openrouter',
    name: 'OpenRouter',
    type: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    iconKey: 'openrouter'
  },
  {
    key: 'packycode',
    name: 'PackyCode',
    type: 'anthropic',
    baseUrl: 'https://www.packyapi.com/v1',
    iconKey: 'packycode'
  },
  {
    key: 'vercel-ai-gateway',
    name: 'Vercel AI Gateway',
    type: 'vercel-gateway',
    baseUrl: 'https://ai-gateway.vercel.sh/v3/ai',
    iconKey: 'vercel'
  },
  {
    key: 'zhipu-glm',
    name: 'Zhipu GLM',
    type: 'anthropic',
    baseUrl: 'https://open.bigmodel.cn/api/anthropic',
    iconKey: 'zhipu'
  },
  {
    key: 'zai',
    name: 'Z.ai',
    type: 'anthropic',
    baseUrl: 'https://api.z.ai/api/anthropic',
    iconKey: 'zai'
  }
]

/** Find a preset by key */
export function findProviderPreset(key: string): ProviderPreset | undefined {
  return providerPresets.find((p) => p.key === key)
}

/** Best-effort match: find a preset whose iconKey or name matches a provider's config */
export function matchProviderPreset(name: string, baseUrl: string): ProviderPreset | undefined {
  // Exact base URL match first (most reliable)
  const byUrl = baseUrl.trim()
    ? providerPresets.find((p) => p.baseUrl && p.baseUrl === baseUrl.trim())
    : undefined
  if (byUrl) return byUrl

  // Fall back to case-insensitive name match
  const lower = name.toLowerCase()
  return providerPresets.find((p) => p.name.toLowerCase() === lower || p.key === lower)
}

/** Create a ProviderConfig from a preset (empty apiKey/models, ready for user to fill in) */
function presetToProviderConfig(preset: ProviderPreset): ProviderConfig {
  return {
    id: createProviderId(),
    presetKey: preset.key,
    name: preset.name,
    type: preset.type,
    thinkingEnabled: true,
    apiKey: '',
    baseUrl: preset.baseUrl,
    modelList: { enabled: [], disabled: [] }
  }
}

/** Generate ProviderConfig entries for all presets */
export function createPresetProviders(): ProviderConfig[] {
  return providerPresets.map(presetToProviderConfig)
}

/**
 * Backfill presetKey on legacy provider entries that were created before
 * presetKey was introduced. Mutates in place for efficiency.
 *
 * Only matches by exact baseUrl — name matching is intentionally excluded
 * because it would incorrectly tag custom providers that happen to share
 * a preset name (e.g. a custom "OpenAI" pointing at a proxy).
 * Each preset key is assigned at most once.
 */
function backfillPresetKeys(providers: ProviderConfig[]): void {
  const claimed = new Set(providers.map((p) => p.presetKey).filter(Boolean))

  for (const provider of providers) {
    if (provider.presetKey) continue
    const url = provider.baseUrl.trim()
    if (!url) continue
    const match = providerPresets.find((p) => p.baseUrl && p.baseUrl === url)
    if (match && !claimed.has(match.key)) {
      provider.presetKey = match.key
      claimed.add(match.key)
    }
  }
}

/**
 * Merge missing preset providers into an existing provider list.
 * Backfills presetKey on legacy entries first, then matches by presetKey.
 * Existing providers are never replaced.
 */
export function mergePresetProviders(existing: ProviderConfig[]): ProviderConfig[] {
  backfillPresetKeys(existing)

  const keySet = new Set(existing.map((p) => p.presetKey).filter(Boolean))

  const missing = providerPresets.filter((preset) => !keySet.has(preset.key))

  if (missing.length === 0) return existing
  return [...existing, ...missing.map(presetToProviderConfig)]
}
