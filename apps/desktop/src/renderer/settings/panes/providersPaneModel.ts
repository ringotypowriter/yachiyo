export interface ProviderModelLists {
  enabled: string[]
  disabled: string[]
  imageIncapable?: string[]
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

export function toggleProviderModel(
  modelList: ProviderModelLists,
  model: string
): ProviderModelLists {
  const isEnabled = modelList.enabled.includes(model)
  return isEnabled
    ? {
        ...modelList,
        enabled: modelList.enabled.filter((m) => m !== model),
        disabled: [...modelList.disabled, model]
      }
    : {
        ...modelList,
        enabled: [...modelList.enabled, model],
        disabled: modelList.disabled.filter((m) => m !== model)
      }
}
