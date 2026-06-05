import type {
  EssentialPreset,
  NamedSubagentId,
  SubagentProfile,
  SubagentsConfig,
  ThreadModelOverride
} from '@yachiyo/shared/protocol'
import { DEFAULT_SETTINGS_CONFIG } from './settingsDefaults.ts'
import { asRecord, normalizeString } from './settingsNormalizationShared.ts'

const VALID_NAMED_SUBAGENT_IDS: NamedSubagentId[] = ['explore', 'plan', 'review', 'general']

function normalizeThreadModelOverride(value: unknown): ThreadModelOverride | undefined {
  const input = asRecord(value)
  const providerName = normalizeString(input['providerName'], '')
  const model = normalizeString(input['model'], '')

  if (!providerName || !model) {
    return undefined
  }

  return { providerName, model }
}

function normalizeSubagentProfile(value: unknown): SubagentProfile | null {
  const input = asRecord(value)
  const id = normalizeString(input['id'], '')
  const name = normalizeString(input['name'], '')

  if (!id || !name) {
    return null
  }

  const rawArgs = input['args']
  const args = Array.isArray(rawArgs)
    ? rawArgs.map((item) => normalizeString(item, '')).filter(Boolean)
    : []

  const env: Record<string, string> = {}
  const rawEnv = input['env']
  if (rawEnv && typeof rawEnv === 'object' && !Array.isArray(rawEnv)) {
    for (const [key, entryValue] of Object.entries(rawEnv as Record<string, unknown>)) {
      if (typeof entryValue === 'string') {
        env[key] = entryValue
      }
    }
  }

  const showInChatPicker =
    typeof input['showInChatPicker'] === 'boolean' ? input['showInChatPicker'] : undefined
  const allowDirectChat =
    typeof input['allowDirectChat'] === 'boolean' ? input['allowDirectChat'] : undefined
  const allowDelegation =
    typeof input['allowDelegation'] === 'boolean' ? input['allowDelegation'] : undefined

  return {
    id,
    name,
    enabled: input['enabled'] === true,
    description: normalizeString(input['description'], ''),
    command: normalizeString(input['command'], ''),
    args,
    env,
    ...(showInChatPicker !== undefined ? { showInChatPicker } : {}),
    ...(allowDirectChat !== undefined ? { allowDirectChat } : {}),
    ...(allowDelegation !== undefined ? { allowDelegation } : {})
  }
}

export function normalizeSubagentProfiles(value: unknown): SubagentProfile[] {
  if (!Array.isArray(value)) {
    return DEFAULT_SETTINGS_CONFIG.subagentProfiles ?? []
  }

  return value.flatMap((item) => {
    const profile = normalizeSubagentProfile(item)
    return profile ? [profile] : []
  })
}

function normalizeEssentialPreset(value: unknown): EssentialPreset | null {
  const input = asRecord(value)
  const id = normalizeString(input['id'], '')
  const icon = normalizeString(input['icon'], '')

  if (!id) {
    return null
  }

  const iconType = input['iconType'] === 'image' ? 'image' : 'emoji'
  const label = normalizeString(input['label'], '') || undefined
  const workspacePath = normalizeString(input['workspacePath'], '') || undefined
  const privacyMode = typeof input['privacyMode'] === 'boolean' ? input['privacyMode'] : undefined
  const order = typeof input['order'] === 'number' ? input['order'] : 0
  const modelOverride = normalizeThreadModelOverride(input['modelOverride'])

  return {
    id,
    icon,
    iconType,
    label,
    workspacePath,
    ...(privacyMode === undefined ? {} : { privacyMode }),
    modelOverride,
    order
  }
}

export function normalizeEssentials(value: unknown): EssentialPreset[] {
  if (!Array.isArray(value)) {
    return []
  }

  return value.flatMap((item) => {
    const preset = normalizeEssentialPreset(item)
    return preset ? [preset] : []
  })
}

export function normalizeSubagentsConfig(value: unknown): SubagentsConfig {
  const input = asRecord(value)
  const rawMode = input['mode']
  const mode: import('@yachiyo/shared/protocol').SubagentRuntimeMode =
    rawMode === 'acp' ? 'acp' : 'worker'
  const defaultEnabled = DEFAULT_SETTINGS_CONFIG.subagents?.enabledNamedAgents ?? []
  const rawEnabled = input['enabledNamedAgents']
  const enabledNamedAgents = Array.isArray(rawEnabled)
    ? rawEnabled
        .filter((id): id is string => typeof id === 'string')
        .filter((id): id is NamedSubagentId =>
          VALID_NAMED_SUBAGENT_IDS.includes(id as NamedSubagentId)
        )
    : defaultEnabled

  const rawPreferredModels = input['preferredModels']
  const preferredModels: Partial<Record<NamedSubagentId, ThreadModelOverride>> = {}
  if (
    rawPreferredModels &&
    typeof rawPreferredModels === 'object' &&
    !Array.isArray(rawPreferredModels)
  ) {
    for (const agentId of VALID_NAMED_SUBAGENT_IDS) {
      const override = normalizeThreadModelOverride(
        (rawPreferredModels as Record<string, unknown>)[agentId]
      )
      if (override) {
        preferredModels[agentId] = override
      }
    }
  }

  return {
    mode,
    enabledNamedAgents: [...new Set(enabledNamedAgents)],
    ...(Object.keys(preferredModels).length > 0 ? { preferredModels } : {})
  }
}
