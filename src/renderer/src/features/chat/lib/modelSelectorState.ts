import type { SettingsConfig, ToolModelMode } from '../../../../../shared/yachiyo/protocol.ts'

export interface FilteredModelProvider {
  name: string
  type: SettingsConfig['providers'][number]['type']
  models: string[]
}

export interface AcpAgentEntry {
  id: string
  name: string
  description: string
}

export interface ModelSelectorState {
  providers: FilteredModelProvider[]
  acpAgents: AcpAgentEntry[]
  showEmptyState: boolean
  showLeadingOption: boolean
}

export function canOpenToolModelPicker(input: {
  hasEnabledModels: boolean
  toolModelMode: ToolModelMode
}): boolean {
  return (
    input.hasEnabledModels || input.toolModelMode === 'custom' || input.toolModelMode === 'default'
  )
}

export function filterEnabledModelProviders(
  config: Pick<SettingsConfig, 'providers'>,
  query: string
): FilteredModelProvider[] {
  const normalizedQuery = query.trim().toLowerCase()

  return config.providers
    .map((provider) => ({
      name: provider.name,
      type: provider.type,
      models: provider.modelList.enabled.filter(
        (model) =>
          normalizedQuery.length === 0 ||
          model.toLowerCase().includes(normalizedQuery) ||
          provider.name.toLowerCase().includes(normalizedQuery)
      )
    }))
    .filter((provider) => provider.models.length > 0)
}

export function filterAcpAgents(
  config: Pick<SettingsConfig, 'subagentProfiles'>,
  query: string
): AcpAgentEntry[] {
  const normalizedQuery = query.trim().toLowerCase()
  return (config.subagentProfiles ?? [])
    .filter(
      (p) =>
        p.enabled &&
        p.showInChatPicker &&
        (normalizedQuery.length === 0 || p.name.toLowerCase().includes(normalizedQuery))
    )
    .map((p) => ({ id: p.id, name: p.name, description: p.description }))
}

export function resolveModelSelectorState(input: {
  config: Pick<SettingsConfig, 'providers' | 'subagentProfiles'>
  hasLeadingOption: boolean
  query: string
}): ModelSelectorState {
  const providers = filterEnabledModelProviders(input.config, input.query)
  const acpAgents = filterAcpAgents(input.config, input.query)

  return {
    providers,
    acpAgents,
    showEmptyState: providers.length === 0 && acpAgents.length === 0,
    showLeadingOption: input.hasLeadingOption
  }
}
