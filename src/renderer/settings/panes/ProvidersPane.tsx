import { Loader2, Plus, RefreshCw, Trash2, X } from 'lucide-react'
import { useState } from 'react'
import { theme } from '@renderer/theme/theme'
import type {
  ProviderConfig,
  ProviderKind,
  SettingsConfig
} from '../../../shared/yachiyo/protocol.ts'
import {
  createDisabledToolModelConfig,
  createProviderConfig,
  getToolModelConfig,
  providerMatchesReference,
  sanitizeProviderConfig,
  syncToolModelWithProvider,
  toolModelTargetsProvider
} from '../../../shared/yachiyo/providerConfig.ts'
import { Field, PlaceholderPane, SettingSwitch } from '../components/primitives'
import { inputStyle } from '../components/styles'

interface ModelToggleProps {
  enabled: boolean
  model: string
  onRemove: () => void
  onToggle: () => void
}

interface ModelListSectionProps {
  onProviderChange: (update: (provider: ProviderConfig) => ProviderConfig) => void
  provider: ProviderConfig
}

interface ProvidersPaneProps {
  draft: SettingsConfig
  onChange: (next: SettingsConfig) => void
  onSelectProvider: (id: string) => void
  selectedProviderId: string
}

function withSelectedProvider(
  config: SettingsConfig,
  selectedProviderId: string,
  update: (provider: ProviderConfig) => ProviderConfig
): { config: SettingsConfig; nextSelectedId: string } {
  const current =
    config.providers.find((provider) =>
      providerMatchesReference(provider, { id: selectedProviderId })
    ) ?? null
  if (!current) {
    return { config, nextSelectedId: selectedProviderId }
  }

  const nextProvider = sanitizeProviderConfig(update(current))
  const toolModel = getToolModelConfig(config)
  const toolModelTargetsCurrentProvider =
    toolModel.mode === 'custom' && toolModelTargetsProvider(toolModel, current)

  return {
    config: {
      ...config,
      ...(toolModelTargetsCurrentProvider
        ? {
            toolModel: syncToolModelWithProvider(toolModel, nextProvider)
          }
        : {}),
      providers: config.providers.map((provider) =>
        providerMatchesReference(provider, { id: current.id }) ? nextProvider : provider
      )
    },
    nextSelectedId: nextProvider.id ?? selectedProviderId
  }
}

function ModelToggle({ model, enabled, onToggle, onRemove }: ModelToggleProps): React.ReactNode {
  return (
    <div
      className="flex items-center justify-between px-3 py-2 rounded-lg transition-colors"
      style={{
        background: enabled ? theme.background.accentSoft : theme.background.surfaceSoft,
        boxShadow: `inset 0 0 0 1px ${theme.border.subtle}`
      }}
    >
      <span className="text-sm truncate mr-3" style={{ color: theme.text.primary }}>
        {model}
      </span>
      <div className="flex items-center gap-2 shrink-0">
        <button
          type="button"
          onClick={onRemove}
          className="p-0.5 rounded opacity-0 hover:opacity-100 group-hover:opacity-40 transition-opacity"
          title="Remove model"
        >
          <X size={12} strokeWidth={1.5} color={theme.icon.muted} />
        </button>
        <SettingSwitch
          checked={enabled}
          onChange={onToggle}
          ariaLabel={`${enabled ? 'Disable' : 'Enable'} ${model}`}
        />
      </div>
    </div>
  )
}

function ModelListSection({ provider, onProviderChange }: ModelListSectionProps): React.ReactNode {
  const [fetching, setFetching] = useState(false)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [manualInput, setManualInput] = useState('')

  const allModels = [...provider.modelList.enabled, ...provider.modelList.disabled]

  const handleFetch = async (): Promise<void> => {
    setFetching(true)
    setFetchError(null)
    try {
      const models = await window.api.yachiyo.fetchProviderModels(provider)
      if (models.length === 0) return

      onProviderChange((p) => {
        const existing = new Set([...p.modelList.enabled, ...p.modelList.disabled])
        const newModels = models.filter((m) => !existing.has(m))
        return {
          ...p,
          modelList: {
            ...p.modelList,
            disabled: [...p.modelList.disabled, ...newModels]
          }
        }
      })
    } catch (error) {
      setFetchError(error instanceof Error ? error.message : 'Failed to fetch models')
    } finally {
      setFetching(false)
    }
  }

  const handleToggle = (model: string): void => {
    onProviderChange((p) => {
      const isEnabled = p.modelList.enabled.includes(model)
      return {
        ...p,
        modelList: isEnabled
          ? {
              enabled: p.modelList.enabled.filter((m) => m !== model),
              disabled: [...p.modelList.disabled, model]
            }
          : {
              enabled: [...p.modelList.enabled, model],
              disabled: p.modelList.disabled.filter((m) => m !== model)
            }
      }
    })
  }

  const handleRemoveModel = (model: string): void => {
    onProviderChange((p) => ({
      ...p,
      modelList: {
        enabled: p.modelList.enabled.filter((m) => m !== model),
        disabled: p.modelList.disabled.filter((m) => m !== model)
      }
    }))
  }

  const handleAddManual = (): void => {
    const model = manualInput.trim()
    if (!model || allModels.includes(model)) {
      setManualInput('')
      return
    }

    onProviderChange((p) => ({
      ...p,
      modelList: {
        ...p.modelList,
        disabled: [...p.modelList.disabled, model]
      }
    }))
    setManualInput('')
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium" style={{ color: theme.text.primary }}>
          Models
        </span>
        <button
          type="button"
          onClick={() => void handleFetch()}
          disabled={fetching || !provider.apiKey.trim()}
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium transition-opacity disabled:opacity-40"
          style={{
            background: theme.background.accentMuted,
            color: theme.text.accent
          }}
          title={!provider.apiKey.trim() ? 'Add an API key first' : 'Fetch available models'}
        >
          {fetching ? (
            <Loader2 size={12} strokeWidth={2} className="animate-spin" />
          ) : (
            <RefreshCw size={12} strokeWidth={2} />
          )}
          {fetching ? 'Fetching...' : 'Fetch'}
        </button>
      </div>

      <div
        className="rounded-2xl overflow-hidden"
        style={{
          border: `1px solid ${theme.border.default}`,
          background: theme.background.surfaceSoft
        }}
      >
        {allModels.length === 0 ? (
          <div className="px-4 py-6 text-center">
            <span className="text-sm" style={{ color: theme.text.muted }}>
              No models yet. Fetch from API or add manually.
            </span>
          </div>
        ) : (
          <div className="space-y-1 p-1.5">
            {provider.modelList.enabled.map((model) => (
              <div key={model} className="group rounded-xl">
                <ModelToggle
                  model={model}
                  enabled
                  onToggle={() => handleToggle(model)}
                  onRemove={() => handleRemoveModel(model)}
                />
              </div>
            ))}
            {provider.modelList.disabled.map((model) => (
              <div key={model} className="group rounded-xl">
                <ModelToggle
                  model={model}
                  enabled={false}
                  onToggle={() => handleToggle(model)}
                  onRemove={() => handleRemoveModel(model)}
                />
              </div>
            ))}
          </div>
        )}

        <div
          className="flex items-center gap-2 px-3 py-2"
          style={{ borderTop: `1px solid ${theme.border.subtle}` }}
        >
          <input
            value={manualInput}
            onChange={(event) => setManualInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                handleAddManual()
              }
            }}
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-gray-400"
            style={{ color: theme.text.primary }}
            placeholder="Add model name..."
          />
          <button
            type="button"
            onClick={handleAddManual}
            disabled={!manualInput.trim()}
            className="p-1 rounded-md transition-opacity disabled:opacity-30"
            title="Add model"
          >
            <Plus size={14} strokeWidth={2} color={theme.icon.accent} />
          </button>
        </div>
      </div>

      {allModels.length > 0 ? (
        <div className="text-xs" style={{ color: theme.text.muted }}>
          {provider.modelList.enabled.length} enabled, {provider.modelList.disabled.length} disabled
        </div>
      ) : null}

      {fetchError ? (
        <div
          className="flex items-center gap-2 rounded-xl px-3 py-2 text-xs"
          style={{
            background: theme.background.dangerSurface,
            color: theme.text.dangerStrong
          }}
        >
          <span className="shrink-0">Fetch failed:</span>
          <span className="truncate">{fetchError}</span>
          <button
            type="button"
            onClick={() => setFetchError(null)}
            className="shrink-0 p-0.5 rounded hover:bg-black/5"
          >
            <X size={12} strokeWidth={1.5} />
          </button>
        </div>
      ) : null}
    </div>
  )
}

export function ProvidersPane({
  draft,
  selectedProviderId,
  onSelectProvider,
  onChange
}: ProvidersPaneProps): React.ReactNode {
  const selectedProvider =
    draft.providers.find((provider) => provider.id === selectedProviderId) ?? null

  const handleProviderChange = (update: (provider: ProviderConfig) => ProviderConfig): void => {
    if (!selectedProvider) {
      return
    }

    const next = withSelectedProvider(draft, selectedProvider.id ?? '', update)
    onChange(next.config)
    onSelectProvider(next.nextSelectedId)
  }

  const handleAddProvider = (): void => {
    const provider = createProviderConfig(draft.providers.map((entry) => entry.name))
    onChange({
      ...draft,
      providers: [...draft.providers, provider]
    })
    onSelectProvider(provider.id ?? '')
  }

  const handleRemoveProvider = (): void => {
    if (!selectedProvider) {
      return
    }

    const toolModel = getToolModelConfig(draft)
    const providers = draft.providers.filter((provider) => provider.id !== selectedProvider.id)
    onChange({
      ...draft,
      ...(toolModel.mode === 'custom' && toolModelTargetsProvider(toolModel, selectedProvider)
        ? {
            toolModel: createDisabledToolModelConfig()
          }
        : {}),
      providers
    })
    onSelectProvider(providers[0]?.id ?? '')
  }

  return (
    <div className="flex flex-1 min-h-0">
      <div
        className="shrink-0 flex flex-col"
        style={{
          width: 250,
          borderRight: `1px solid ${theme.border.default}`,
          background: theme.background.sidebar
        }}
      >
        <div className="flex items-center justify-between px-5 py-4">
          <div>
            <div className="text-sm font-semibold" style={{ color: theme.text.primary }}>
              Providers
            </div>
            <div className="text-xs" style={{ color: theme.text.muted }}>
              {draft.providers.length} configured
            </div>
          </div>
          <button
            type="button"
            onClick={handleAddProvider}
            className="flex items-center gap-1 rounded-full px-2.5 py-1.5 text-xs font-medium"
            style={{ background: theme.text.accent, color: theme.text.inverse }}
          >
            <Plus size={12} strokeWidth={2} />
            Add
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-3 pb-4">
          {draft.providers.map((provider) => {
            const isSelected = provider.id === selectedProviderId

            return (
              <button
                key={provider.id}
                type="button"
                onClick={() => onSelectProvider(provider.id ?? '')}
                className="mb-2 w-full rounded-2xl px-3 py-3 text-left transition-all"
                style={
                  isSelected
                    ? {
                        background: theme.background.surfaceFrosted,
                        boxShadow: theme.shadow.raised
                      }
                    : {
                        background: theme.background.surfaceSoft
                      }
                }
              >
                <div className="min-w-0">
                  <div
                    className="truncate text-sm font-semibold"
                    style={{ color: theme.text.primary, letterSpacing: '-0.2px' }}
                  >
                    {provider.name}
                  </div>
                  <div
                    className="text-xs uppercase tracking-[0.14em]"
                    style={{ color: theme.text.muted }}
                  >
                    {provider.type}
                  </div>
                </div>
                <div className="mt-3 text-xs" style={{ color: theme.text.tertiary }}>
                  {provider.modelList.enabled.length} enabled
                </div>
              </button>
            )
          })}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-7 py-6">
        {selectedProvider ? (
          <div className="max-w-3xl space-y-6">
            <div className="flex items-start justify-between gap-4">
              <div
                className="text-2xl font-semibold"
                style={{ color: theme.text.primary, letterSpacing: '-0.4px' }}
              >
                {selectedProvider.name}
              </div>

              <button
                type="button"
                onClick={handleRemoveProvider}
                className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium"
                style={{
                  background: theme.background.dangerSurface,
                  color: theme.text.dangerStrong
                }}
              >
                <Trash2 size={12} strokeWidth={1.8} />
                Remove
              </button>
            </div>

            <div className="grid grid-cols-2 gap-5">
              <Field label="Name">
                <input
                  value={selectedProvider.name}
                  onChange={(event) =>
                    handleProviderChange((provider) => ({
                      ...provider,
                      name: event.target.value
                    }))
                  }
                  className="w-full rounded-xl px-3 py-2.5 text-sm outline-none"
                  style={inputStyle()}
                  placeholder="work-openai"
                />
              </Field>

              <Field label="Type">
                <select
                  value={selectedProvider.type}
                  onChange={(event) =>
                    handleProviderChange((provider) => ({
                      ...provider,
                      type: event.target.value as ProviderKind
                    }))
                  }
                  className="w-full rounded-xl px-3 py-2.5 text-sm outline-none"
                  style={inputStyle()}
                >
                  <option value="openai">OpenAI</option>
                  <option value="anthropic">Anthropic</option>
                  <option value="vertex">Vertex</option>
                </select>
              </Field>

              <div className="col-span-2">
                <Field label="API Key">
                  <input
                    type="password"
                    value={selectedProvider.apiKey}
                    onChange={(event) =>
                      handleProviderChange((provider) => ({
                        ...provider,
                        apiKey: event.target.value
                      }))
                    }
                    className="w-full rounded-xl px-3 py-2.5 text-sm outline-none"
                    style={inputStyle()}
                    placeholder={
                      selectedProvider.type === 'anthropic'
                        ? 'sk-ant-...'
                        : selectedProvider.type === 'vertex'
                          ? 'vgw_...'
                          : 'sk-...'
                    }
                  />
                </Field>
              </div>

              <div className="col-span-2">
                <Field label="Base URL">
                  <input
                    value={selectedProvider.baseUrl}
                    onChange={(event) =>
                      handleProviderChange((provider) => ({
                        ...provider,
                        baseUrl: event.target.value
                      }))
                    }
                    className="w-full rounded-xl px-3 py-2.5 text-sm outline-none"
                    style={inputStyle()}
                    placeholder={
                      selectedProvider.type === 'anthropic'
                        ? 'https://api.anthropic.com/v1'
                        : selectedProvider.type === 'vertex'
                          ? 'https://ai-gateway.vercel.sh/v3/ai'
                          : 'https://api.openai.com/v1'
                    }
                  />
                </Field>
              </div>
            </div>

            <ModelListSection provider={selectedProvider} onProviderChange={handleProviderChange} />
          </div>
        ) : (
          <PlaceholderPane label="Add your first provider to get started." />
        )}
      </div>
    </div>
  )
}
