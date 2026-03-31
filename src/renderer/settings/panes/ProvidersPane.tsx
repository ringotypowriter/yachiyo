import { Eraser, Loader2, Plus, RefreshCw, Search, Trash2, X } from 'lucide-react'
import { useDeferredValue, useMemo, useState } from 'react'
import { theme, alpha } from '@renderer/theme/theme'
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
import { imeSafeChange } from '../components/imeUtils'
import { Field, PlaceholderPane, SettingSwitch, SimpleSelect } from '../components/primitives'
import { inputStyle } from '../components/styles'
import { filterProviderModels } from './providersPaneModel'

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
  const [hovered, setHovered] = useState(false)

  return (
    <div
      className="group flex items-center justify-between px-3 py-2 rounded-lg transition-colors overflow-hidden"
      style={{
        background: hovered ? theme.background.hover : 'transparent'
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <span className="text-sm truncate mr-3" style={{ color: theme.text.primary }}>
        {model}
      </span>
      <div className="flex items-center gap-2 shrink-0">
        <button
          type="button"
          onClick={onRemove}
          className="p-0.5 rounded opacity-0 group-hover:opacity-40 hover:opacity-100! transition-opacity"
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
  const [query, setQuery] = useState('')
  const deferredQuery = useDeferredValue(query)

  const allModels = [...provider.modelList.enabled, ...provider.modelList.disabled]
  const filteredModelList = useMemo(
    () => filterProviderModels(provider.modelList, deferredQuery),
    [provider.modelList, deferredQuery]
  )
  const filteredModelCount = filteredModelList.enabled.length + filteredModelList.disabled.length

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

  const handleClearAll = (): void => {
    onProviderChange((p) => ({
      ...p,
      modelList: { enabled: [], disabled: [] }
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
        <div className="flex items-center gap-2">
          {allModels.length > 0 && (
            <button
              type="button"
              onClick={handleClearAll}
              className="flex items-center gap-1 text-xs font-medium transition-opacity opacity-50 hover:opacity-100"
              style={{ color: theme.text.danger }}
              title="Clear all models"
            >
              <Eraser size={12} strokeWidth={2} />
              Clear
            </button>
          )}
          <button
            type="button"
            onClick={() => void handleFetch()}
            disabled={fetching || (provider.type !== 'vertex' && !provider.apiKey.trim())}
            className="flex items-center gap-1 text-xs font-medium transition-opacity opacity-60 hover:opacity-100 disabled:opacity-20"
            style={{ color: theme.text.accent }}
            title={
              provider.type !== 'vertex' && !provider.apiKey.trim()
                ? 'Add an API key first'
                : 'Fetch available models'
            }
          >
            {fetching ? (
              <Loader2 size={12} strokeWidth={2} className="animate-spin" />
            ) : (
              <RefreshCw size={12} strokeWidth={2} />
            )}
            {fetching ? 'Fetching...' : 'Fetch'}
          </button>
        </div>
      </div>

      {fetchError ? (
        <div className="flex items-center gap-2 text-xs" style={{ color: theme.text.danger }}>
          <span className="truncate">Fetch failed: {fetchError}</span>
          <button
            type="button"
            onClick={() => setFetchError(null)}
            className="shrink-0 opacity-60 hover:opacity-100 transition-opacity"
          >
            <X size={12} strokeWidth={1.5} />
          </button>
        </div>
      ) : null}

      <div>
        {allModels.length === 0 ? (
          <div className="py-6 text-center">
            <span className="text-sm" style={{ color: theme.text.muted }}>
              No models yet. Fetch from API or add manually.
            </span>
          </div>
        ) : (
          <>
            <label
              className="flex items-center gap-2 px-3 py-2 rounded-lg mb-1"
              style={{ background: alpha('ink', 0.04) }}
            >
              <Search size={13} strokeWidth={1.75} color={theme.icon.placeholder} />
              <input
                type="search"
                value={query}
                onChange={imeSafeChange(setQuery)}
                placeholder="Search models"
                aria-label="Search provider models"
                className="min-w-0 flex-1 bg-transparent text-sm outline-none"
                style={{ color: theme.text.primary }}
              />
            </label>

            {filteredModelCount === 0 ? (
              <div className="py-6 text-center">
                <span className="text-sm" style={{ color: theme.text.muted }}>
                  No models match &ldquo;{query.trim()}&rdquo;.
                </span>
              </div>
            ) : (
              <div className="space-y-0.5 py-1">
                {filteredModelList.enabled.map((model) => (
                  <ModelToggle
                    key={model}
                    model={model}
                    enabled
                    onToggle={() => handleToggle(model)}
                    onRemove={() => handleRemoveModel(model)}
                  />
                ))}
                {filteredModelList.disabled.map((model) => (
                  <ModelToggle
                    key={model}
                    model={model}
                    enabled={false}
                    onToggle={() => handleToggle(model)}
                    onRemove={() => handleRemoveModel(model)}
                  />
                ))}
              </div>
            )}
          </>
        )}

        <div
          className="flex items-center gap-2 py-2"
          style={{ borderTop: `1px solid ${theme.border.subtle}` }}
        >
          <input
            value={manualInput}
            onChange={imeSafeChange(setManualInput)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return
              if (event.key === 'Enter') {
                event.preventDefault()
                handleAddManual()
              }
            }}
            className="flex-1 bg-transparent text-sm outline-none"
            style={{ color: theme.text.primary }}
            placeholder="Add model name..."
          />
          <button
            type="button"
            onClick={handleAddManual}
            disabled={!manualInput.trim()}
            className="transition-opacity disabled:opacity-25 opacity-50 hover:opacity-100"
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
          borderRight: `1px solid ${theme.border.subtle}`,
          background: theme.background.surface
        }}
      >
        <div className="flex-1 overflow-y-auto py-1">
          {draft.providers.map((provider) => {
            const isSelected = provider.id === selectedProviderId

            return (
              <button
                key={provider.id}
                type="button"
                onClick={() => onSelectProvider(provider.id ?? '')}
                className="w-full flex items-center justify-between px-3 py-2 rounded-lg text-left transition-all mb-0.5 mx-1"
                style={
                  isSelected
                    ? {
                        background: theme.background.accentSoft,
                        color: theme.text.accent,
                        width: 'calc(100% - 8px)'
                      }
                    : { color: theme.text.secondary, width: 'calc(100% - 8px)' }
                }
              >
                <div className="min-w-0">
                  <div
                    className="truncate text-sm font-medium"
                    style={{ color: isSelected ? theme.text.accent : theme.text.primary }}
                  >
                    {provider.name}
                  </div>
                  <div
                    className="text-xs"
                    style={{
                      color: isSelected ? theme.text.accent : theme.text.muted,
                      opacity: 0.7
                    }}
                  >
                    {provider.type} · {provider.modelList.enabled.length} enabled
                  </div>
                </div>
              </button>
            )
          })}
        </div>

        <div
          className="shrink-0 px-4 py-3"
          style={{ borderTop: `1px solid ${theme.border.subtle}` }}
        >
          <button
            type="button"
            onClick={handleAddProvider}
            className="flex items-center gap-1 text-xs font-medium transition-opacity opacity-60 hover:opacity-100"
            style={{ color: theme.text.accent }}
          >
            <Plus size={12} strokeWidth={2} />
            Add provider
          </button>
        </div>
      </div>

      <div className="flex flex-col flex-1 min-w-0 overflow-y-auto">
        {selectedProvider ? (
          <div key={selectedProvider.id} className="space-y-5 px-7 pt-5 pb-6">
            <div className="flex items-center justify-between gap-4">
              <div
                className="text-xl font-semibold"
                style={{ color: theme.text.primary, letterSpacing: '-0.3px' }}
              >
                {selectedProvider.name}
              </div>

              <button
                type="button"
                onClick={handleRemoveProvider}
                className="flex items-center gap-1.5 text-xs font-medium transition-opacity opacity-50 hover:opacity-100"
                style={{ color: theme.text.danger }}
              >
                <Trash2 size={12} strokeWidth={1.8} />
                Remove
              </button>
            </div>

            <div className="grid grid-cols-2 gap-5">
              <Field label="Name">
                <input
                  value={selectedProvider.name}
                  onChange={imeSafeChange((value) =>
                    handleProviderChange((provider) => ({
                      ...provider,
                      name: value
                    }))
                  )}
                  className="w-full rounded-xl px-3 py-2.5 text-sm outline-none"
                  style={inputStyle()}
                  placeholder="work-openai"
                />
              </Field>

              <Field label="Type">
                <SimpleSelect<ProviderKind>
                  value={selectedProvider.type}
                  width="100%"
                  options={[
                    { value: 'openai', label: 'OpenAI (Chat)' },
                    { value: 'openai-responses', label: 'OpenAI (Responses)' },
                    { value: 'anthropic', label: 'Anthropic' },
                    { value: 'gemini', label: 'Google AI / Gemini' },
                    { value: 'vertex', label: 'Google Vertex AI' },
                    { value: 'vercel-gateway', label: 'Vercel AI Gateway' }
                  ]}
                  onChange={(type) => handleProviderChange((provider) => ({ ...provider, type }))}
                />
              </Field>

              {selectedProvider.type === 'vertex' ? (
                <>
                  <Field label="Project ID">
                    <input
                      value={selectedProvider.project ?? ''}
                      onChange={imeSafeChange((value) =>
                        handleProviderChange((provider) => ({
                          ...provider,
                          project: value
                        }))
                      )}
                      className="w-full rounded-xl px-3 py-2.5 text-sm outline-none"
                      style={inputStyle()}
                      placeholder="my-gcp-project"
                    />
                  </Field>

                  <Field label="Location">
                    <input
                      value={selectedProvider.location ?? ''}
                      onChange={imeSafeChange((value) =>
                        handleProviderChange((provider) => ({
                          ...provider,
                          location: value
                        }))
                      )}
                      className="w-full rounded-xl px-3 py-2.5 text-sm outline-none"
                      style={inputStyle()}
                      placeholder="us-central1"
                    />
                  </Field>

                  <div className="col-span-2">
                    <Field label="Service Account Email">
                      <input
                        value={selectedProvider.serviceAccountEmail ?? ''}
                        onChange={imeSafeChange((value) =>
                          handleProviderChange((provider) => ({
                            ...provider,
                            serviceAccountEmail: value
                          }))
                        )}
                        className="w-full rounded-xl px-3 py-2.5 text-sm outline-none"
                        style={inputStyle()}
                        placeholder="sa@my-project.iam.gserviceaccount.com (optional — uses ADC if empty)"
                      />
                    </Field>
                  </div>

                  <div className="col-span-2">
                    <Field label="Service Account Private Key">
                      <textarea
                        value={selectedProvider.serviceAccountPrivateKey ?? ''}
                        onChange={imeSafeChange((raw) => {
                          // Auto-convert literal \n sequences (from JSON service account files)
                          // into real newlines so the key is stored correctly.
                          const value = raw.replace(/\\n/g, '\n')
                          handleProviderChange((provider) => ({
                            ...provider,
                            serviceAccountPrivateKey: value
                          }))
                        })}
                        rows={4}
                        className="w-full rounded-xl px-3 py-2.5 text-sm outline-none font-mono"
                        style={inputStyle()}
                        placeholder="-----BEGIN PRIVATE KEY-----&#10;(optional — uses ADC if empty)"
                      />
                    </Field>
                  </div>
                </>
              ) : (
                <>
                  <div className="col-span-2">
                    <Field label="API Key">
                      <input
                        type="password"
                        value={selectedProvider.apiKey}
                        onChange={imeSafeChange((value) =>
                          handleProviderChange((provider) => ({
                            ...provider,
                            apiKey: value
                          }))
                        )}
                        className="w-full rounded-xl px-3 py-2.5 text-sm outline-none"
                        style={inputStyle()}
                        placeholder={
                          selectedProvider.type === 'anthropic'
                            ? 'sk-ant-...'
                            : selectedProvider.type === 'gemini'
                              ? 'AIza...'
                              : selectedProvider.type === 'vercel-gateway'
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
                        onChange={imeSafeChange((value) =>
                          handleProviderChange((provider) => ({
                            ...provider,
                            baseUrl: value
                          }))
                        )}
                        className="w-full rounded-xl px-3 py-2.5 text-sm outline-none"
                        style={inputStyle()}
                        placeholder={
                          selectedProvider.type === 'anthropic'
                            ? 'https://api.anthropic.com/v1'
                            : selectedProvider.type === 'gemini'
                              ? 'https://generativelanguage.googleapis.com/v1beta'
                              : selectedProvider.type === 'vercel-gateway'
                                ? 'https://ai-gateway.vercel.sh/v3/ai'
                                : 'https://api.openai.com/v1'
                        }
                      />
                    </Field>
                  </div>
                </>
              )}

              <div className="col-span-2 flex items-center justify-between">
                <span className="text-sm font-medium" style={{ color: theme.text.primary }}>
                  Thinking when applicable
                </span>
                <SettingSwitch
                  checked={selectedProvider.thinkingEnabled !== false}
                  onChange={() =>
                    handleProviderChange((provider) => ({
                      ...provider,
                      thinkingEnabled: provider.thinkingEnabled === false
                    }))
                  }
                  ariaLabel="Thinking when applicable"
                />
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
