import {
  REASONING_EFFORT_LEVELS,
  type ComposerReasoningSelection,
  type ProviderConfig,
  type ProviderKind,
  type ProviderReasoningConfig,
  type ProviderReasoningModelConfig,
  type ProviderSettings,
  type ReasoningEffortLevel
} from './protocol.ts'

export interface ReasoningSelectorState {
  options: ComposerReasoningSelection[]
  selected: ComposerReasoningSelection
}

const DEFAULT_REASONING_EFFORT: ReasoningEffortLevel = 'medium'
const DEFAULT_REASONING_OPTIONS: ReasoningEffortLevel[] = [DEFAULT_REASONING_EFFORT]
const DEEPSEEK_V4_PRO_OPTIONS: ReasoningEffortLevel[] = ['high', 'max']

type ReasoningProvider =
  | Pick<ProviderConfig, 'reasoning' | 'thinkingEnabled' | 'type'>
  | Pick<ProviderSettings, 'reasoning' | 'thinkingEnabled' | 'provider'>

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

export function isReasoningEffortLevel(value: unknown): value is ReasoningEffortLevel {
  return typeof value === 'string' && (REASONING_EFFORT_LEVELS as readonly string[]).includes(value)
}

export function isComposerReasoningSelection(value: unknown): value is ComposerReasoningSelection {
  return value === 'off' || isReasoningEffortLevel(value)
}

function uniqueEfforts(values: unknown): ReasoningEffortLevel[] {
  if (!Array.isArray(values)) {
    return []
  }

  const result: ReasoningEffortLevel[] = []
  for (const value of values) {
    if (isReasoningEffortLevel(value) && !result.includes(value)) {
      result.push(value)
    }
  }
  return result
}

function isDeepSeekV4ProModel(model: string): boolean {
  return model.trim().toLowerCase().endsWith('deepseek-v4-pro')
}

function isClaudeOpus47Model(model: string): boolean {
  const normalized = model.trim().toLowerCase()
  return (
    normalized.includes('claude') &&
    normalized.includes('opus') &&
    /(?:^|[-_.])4[-_.]?7(?:[-_.]|$)/.test(normalized)
  )
}

export function isMaxReasoningEffortModel(model: string): boolean {
  return isDeepSeekV4ProModel(model) || isClaudeOpus47Model(model)
}

export function isOpenAIXHighReasoningEffortModel(model: string): boolean {
  const normalized = model.trim().toLowerCase()
  return (
    normalized.startsWith('gpt-5.3-codex') ||
    normalized.startsWith('gpt-5-3-codex') ||
    normalized.startsWith('gpt-5.4') ||
    normalized.startsWith('gpt-5-4') ||
    normalized.startsWith('gpt-5.5') ||
    normalized.startsWith('gpt-5-5')
  )
}

function getProviderKind(provider: ReasoningProvider): ProviderKind {
  return 'type' in provider ? provider.type : provider.provider
}

function isOpenAIProviderKind(provider: ReasoningProvider): boolean {
  const kind = getProviderKind(provider)
  return kind === 'openai' || kind === 'openai-responses' || kind === 'openai-codex'
}

function isOpenAIReasoningModel(model: string): boolean {
  const normalized = model.trim().toLowerCase()
  return (
    normalized.startsWith('gpt-5') ||
    normalized.startsWith('o1') ||
    normalized.startsWith('o3') ||
    normalized.startsWith('o4')
  )
}

export function isReasoningEffortSelectable(input: {
  provider: ReasoningProvider
  model: string
  effort: ReasoningEffortLevel
}): boolean {
  if (input.effort === 'max') {
    return isMaxReasoningEffortModel(input.model)
  }

  if (
    input.effort === 'xhigh' &&
    isOpenAIProviderKind(input.provider) &&
    isOpenAIReasoningModel(input.model)
  ) {
    return isOpenAIXHighReasoningEffortModel(input.model)
  }

  return true
}

function filterEffortsForProvider(
  provider: ReasoningProvider,
  model: string,
  efforts: ReasoningEffortLevel[]
): ReasoningEffortLevel[] {
  return efforts.filter((effort) => isReasoningEffortSelectable({ provider, model, effort }))
}

function normalizeSelectionForOptions(input: {
  allowOff: boolean
  defaultEffort: unknown
  enabledEfforts: ReasoningEffortLevel[]
}): ComposerReasoningSelection {
  if (input.defaultEffort === 'off' && input.allowOff) {
    return 'off'
  }

  if (
    isReasoningEffortLevel(input.defaultEffort) &&
    input.enabledEfforts.includes(input.defaultEffort)
  ) {
    return input.defaultEffort
  }

  return input.enabledEfforts[0] ?? 'off'
}

function normalizeReasoningModelConfig(value: unknown): ProviderReasoningModelConfig | null {
  const input = isRecord(value) ? value : {}
  const model = typeof input.model === 'string' ? input.model.trim() : ''
  if (!model) {
    return null
  }

  const enabled = typeof input.enabled === 'boolean' ? input.enabled : undefined
  const allowOff = typeof input.allowOff === 'boolean' ? input.allowOff : undefined
  const enabledEfforts =
    enabled === false
      ? []
      : uniqueEfforts(input.enabledEfforts).filter(
          (effort) => effort !== 'max' || isMaxReasoningEffortModel(model)
        )
  const effectiveEfforts =
    enabled === false ? [] : enabledEfforts.length > 0 ? enabledEfforts : DEFAULT_REASONING_OPTIONS
  const effectiveAllowOff = allowOff === true || enabled === false
  const defaultEffort = normalizeSelectionForOptions({
    allowOff: effectiveAllowOff,
    defaultEffort: input.defaultEffort,
    enabledEfforts: effectiveEfforts
  })

  return {
    model,
    ...(enabled !== undefined ? { enabled } : {}),
    enabledEfforts: effectiveEfforts,
    defaultEffort,
    ...(allowOff !== undefined ? { allowOff } : {})
  }
}

export function normalizeProviderReasoningConfig(
  value: unknown
): ProviderReasoningConfig | undefined {
  if (!isRecord(value)) {
    return undefined
  }

  const defaultEffort = isComposerReasoningSelection(value.defaultEffort)
    ? value.defaultEffort
    : undefined
  const rawModels = Array.isArray(value.models) ? value.models : []
  const seen = new Set<string>()
  const models = rawModels.flatMap((item) => {
    const normalized = normalizeReasoningModelConfig(item)
    if (!normalized || seen.has(normalized.model)) {
      return []
    }

    seen.add(normalized.model)
    return [normalized]
  })

  if (defaultEffort === undefined && models.length === 0) {
    return undefined
  }

  return {
    ...(defaultEffort !== undefined ? { defaultEffort } : {}),
    ...(models.length > 0 ? { models } : {})
  }
}

function getModelReasoningConfig(
  reasoning: ProviderReasoningConfig | undefined,
  model: string
): ProviderReasoningModelConfig | undefined {
  return reasoning?.models?.find((entry) => entry.model === model)
}

function getBuiltInReasoningBase(model: string): {
  allowOff: boolean
  defaultEffort: ComposerReasoningSelection
  enabledEfforts: ReasoningEffortLevel[]
} {
  if (isDeepSeekV4ProModel(model)) {
    return {
      allowOff: true,
      defaultEffort: 'max',
      enabledEfforts: DEEPSEEK_V4_PRO_OPTIONS
    }
  }

  return {
    allowOff: false,
    defaultEffort: DEFAULT_REASONING_EFFORT,
    enabledEfforts: DEFAULT_REASONING_OPTIONS
  }
}

function resolveReasoningOptions(input: { provider: ReasoningProvider; model: string }): {
  defaultEffort: ComposerReasoningSelection
  options: ComposerReasoningSelection[]
} {
  if (input.provider.thinkingEnabled === false) {
    return {
      defaultEffort: 'off',
      options: ['off']
    }
  }

  const base = getBuiltInReasoningBase(input.model)
  const override = getModelReasoningConfig(input.provider.reasoning, input.model)

  if (override?.enabled === false) {
    return {
      defaultEffort: 'off',
      options: ['off']
    }
  }

  const enabledEfforts =
    override?.enabledEfforts && override.enabledEfforts.length > 0
      ? filterEffortsForProvider(input.provider, input.model, override.enabledEfforts)
      : base.enabledEfforts
  const effectiveEnabledEfforts = enabledEfforts.length > 0 ? enabledEfforts : base.enabledEfforts
  const allowOff = override?.allowOff ?? base.allowOff
  const options: ComposerReasoningSelection[] = [
    ...(allowOff ? (['off'] as const) : []),
    ...effectiveEnabledEfforts
  ]
  const defaultEffort = normalizeSelectionForOptions({
    allowOff,
    defaultEffort:
      override?.defaultEffort ?? input.provider.reasoning?.defaultEffort ?? base.defaultEffort,
    enabledEfforts: effectiveEnabledEfforts
  })

  return {
    defaultEffort,
    options
  }
}

export function getReasoningSelectorState(input: {
  provider: ReasoningProvider
  model: string
  selected?: ComposerReasoningSelection
}): ReasoningSelectorState {
  const resolved = resolveReasoningOptions(input)
  return {
    options: resolved.options,
    selected:
      input.selected && resolved.options.includes(input.selected)
        ? input.selected
        : resolved.defaultEffort
  }
}

export function resolveReasoningSelection(input: {
  provider: ReasoningProvider
  model: string
  requested?: ComposerReasoningSelection
}): ComposerReasoningSelection {
  const resolved = resolveReasoningOptions(input)
  if (input.requested === undefined) {
    return resolved.defaultEffort
  }

  if (!resolved.options.includes(input.requested)) {
    throw new Error(
      `Reasoning effort "${input.requested}" is not available for model "${input.model}".`
    )
  }

  return input.requested
}
