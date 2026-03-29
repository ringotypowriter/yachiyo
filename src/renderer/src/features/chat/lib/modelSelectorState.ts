import type { SettingsConfig, ToolModelMode } from '../../../../../shared/yachiyo/protocol.ts'

export interface FilteredModelProvider {
  name: string
  type: SettingsConfig['providers'][number]['type']
  models: string[]
}

export interface ModelSelectorState {
  providers: FilteredModelProvider[]
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

export function resolveModelSelectorState(input: {
  config: Pick<SettingsConfig, 'providers'>
  hasLeadingOption: boolean
  query: string
}): ModelSelectorState {
  const providers = filterEnabledModelProviders(input.config, input.query)

  return {
    providers,
    showEmptyState: providers.length === 0,
    showLeadingOption: input.hasLeadingOption
  }
}
