export interface ProviderModelLists {
  enabled: string[]
  disabled: string[]
}

export function filterProviderModels(
  modelList: ProviderModelLists,
  query: string
): ProviderModelLists {
  const normalizedQuery = query.trim().toLowerCase()
  if (!normalizedQuery) {
    return {
      enabled: [...modelList.enabled],
      disabled: [...modelList.disabled]
    }
  }

  return {
    enabled: modelList.enabled.filter((model) => model.toLowerCase().includes(normalizedQuery)),
    disabled: modelList.disabled.filter((model) => model.toLowerCase().includes(normalizedQuery))
  }
}
