import { Copy, Factory, File, Plus, Trash2 } from 'lucide-react'
import { ProviderIconAvatar } from '../../src/lib/providerIcons'
import { theme, alpha } from '@renderer/theme/theme'
import {
  type ProviderConfig,
  type ProviderKind,
  type SettingsConfig
} from '../../../shared/yachiyo/protocol.ts'
import {
  createDisabledToolModelConfig,
  createProviderConfig,
  createProviderId,
  getToolModelConfig,
  modelOverrideTargetsProvider,
  providerMatchesReference,
  sanitizeProviderConfig,
  syncModelOverrideWithProvider,
  syncToolModelWithProvider,
  toolModelTargetsProvider
} from '../../../shared/yachiyo/providerConfig.ts'
import { matchProviderPreset } from '../../../shared/yachiyo/providerPresets.ts'
import { Field, PlaceholderPane, SettingSwitch, SimpleSelect } from '../components/primitives'
import { inputStyle } from '../components/styles'
import { ModelListSection } from './ProviderModelListSection'

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
  const imageToTextModel = config.chat?.imageToTextModel
  const imageToTextModelTargetsCurrentProvider = modelOverrideTargetsProvider(
    imageToTextModel,
    current
  )
  const syncedImageToTextModel =
    imageToTextModel && imageToTextModelTargetsCurrentProvider
      ? syncModelOverrideWithProvider(imageToTextModel, nextProvider)
      : undefined

  return {
    config: {
      ...config,
      ...(toolModelTargetsCurrentProvider
        ? {
            toolModel: syncToolModelWithProvider(toolModel, nextProvider)
          }
        : {}),
      ...(imageToTextModelTargetsCurrentProvider
        ? {
            chat: {
              ...config.chat,
              imageToTextModel: syncedImageToTextModel
            }
          }
        : {}),
      providers: config.providers.map((provider) =>
        providerMatchesReference(provider, { id: current.id }) ? nextProvider : provider
      )
    },
    nextSelectedId: nextProvider.id ?? selectedProviderId
  }
}

const PROVIDER_ICON_SIZE = 18

function ProviderIconBadge({ provider }: { provider: ProviderConfig }): React.ReactNode {
  const preset = matchProviderPreset(provider.name, provider.baseUrl)
  return (
    <div
      className="flex items-center justify-center shrink-0"
      style={{ width: PROVIDER_ICON_SIZE, height: PROVIDER_ICON_SIZE }}
    >
      {preset ? (
        <ProviderIconAvatar iconKey={preset.iconKey} size={PROVIDER_ICON_SIZE} />
      ) : (
        <Factory size={PROVIDER_ICON_SIZE} strokeWidth={1.5} color={theme.icon.muted} />
      )}
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

  const handleDuplicateProvider = (): void => {
    if (!selectedProvider) return
    const existingNames = draft.providers.map((p) => p.name)
    let candidate = `${selectedProvider.name} copy`
    let index = 1
    while (existingNames.includes(candidate)) {
      index += 1
      candidate = `${selectedProvider.name} copy ${index}`
    }
    const duplicated: ProviderConfig = {
      ...selectedProvider,
      id: createProviderId(),
      presetKey: undefined,
      name: candidate
    }
    onChange({
      ...draft,
      providers: [...draft.providers, duplicated]
    })
    onSelectProvider(duplicated.id!)
  }

  const handleAddProvider = (): void => {
    const provider = createProviderConfig(draft.providers.map((entry) => entry.name))
    onChange({
      ...draft,
      providers: [...draft.providers, provider]
    })
    onSelectProvider(provider.id ?? '')
  }

  const isLastOfItsPreset =
    !!selectedProvider?.presetKey &&
    draft.providers.filter((p) => p.presetKey === selectedProvider!.presetKey).length <= 1

  const handleRemoveProvider = (): void => {
    if (!selectedProvider || isLastOfItsPreset) {
      return
    }

    const toolModel = getToolModelConfig(draft)
    const imageToTextModel = draft.chat?.imageToTextModel
    const providers = draft.providers.filter((provider) => provider.id !== selectedProvider.id)
    onChange({
      ...draft,
      ...(toolModel.mode === 'custom' && toolModelTargetsProvider(toolModel, selectedProvider)
        ? {
            toolModel: createDisabledToolModelConfig()
          }
        : {}),
      ...(modelOverrideTargetsProvider(imageToTextModel, selectedProvider)
        ? {
            chat: {
              ...draft.chat,
              imageToTextModel: undefined
            }
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
                className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-left transition-all mb-0.5 mx-1"
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
                <div className="shrink-0">
                  <ProviderIconBadge provider={provider} />
                </div>
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
            Add custom provider
          </button>
        </div>
      </div>

      <div className="flex flex-col flex-1 min-w-0 overflow-y-auto">
        {selectedProvider ? (
          <div key={selectedProvider.id} className="space-y-5 px-7 pt-5 pb-6">
            <div className="flex items-center justify-between gap-4">
              <div
                className="flex items-center gap-2.5 text-xl font-semibold"
                style={{ color: theme.text.primary, letterSpacing: '-0.3px' }}
              >
                <ProviderIconBadge provider={selectedProvider} />
                {selectedProvider.name}
              </div>

              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={handleDuplicateProvider}
                  className="flex items-center gap-1.5 text-xs font-medium transition-opacity opacity-50 hover:opacity-100"
                  style={{ color: theme.text.secondary }}
                >
                  <Copy size={12} strokeWidth={1.8} />
                  Duplicate
                </button>
                {!isLastOfItsPreset && (
                  <button
                    type="button"
                    onClick={handleRemoveProvider}
                    className="flex items-center gap-1.5 text-xs font-medium transition-opacity opacity-50 hover:opacity-100"
                    style={{ color: theme.text.danger }}
                  >
                    <Trash2 size={12} strokeWidth={1.8} />
                    Remove
                  </button>
                )}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-5">
              <Field label="Name">
                <input
                  value={selectedProvider.name}
                  onChange={(e) =>
                    handleProviderChange((provider) => ({
                      ...provider,
                      name: e.target.value
                    }))
                  }
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
                    { value: 'openai-codex', label: 'OpenAI (Codex OAuth)' },
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
                      onChange={(e) =>
                        handleProviderChange((provider) => ({
                          ...provider,
                          project: e.target.value
                        }))
                      }
                      className="w-full rounded-xl px-3 py-2.5 text-sm outline-none"
                      style={inputStyle()}
                      placeholder="my-gcp-project"
                    />
                  </Field>

                  <Field label="Location">
                    <input
                      value={selectedProvider.location ?? ''}
                      onChange={(e) =>
                        handleProviderChange((provider) => ({
                          ...provider,
                          location: e.target.value
                        }))
                      }
                      className="w-full rounded-xl px-3 py-2.5 text-sm outline-none"
                      style={inputStyle()}
                      placeholder="us-central1"
                    />
                  </Field>

                  <div className="col-span-2">
                    <Field label="Service Account Email">
                      <input
                        value={selectedProvider.serviceAccountEmail ?? ''}
                        onChange={(e) =>
                          handleProviderChange((provider) => ({
                            ...provider,
                            serviceAccountEmail: e.target.value
                          }))
                        }
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
                        onChange={(e) => {
                          // Auto-convert literal \n sequences (from JSON service account files)
                          // into real newlines so the key is stored correctly.
                          const value = e.target.value.replace(/\\n/g, '\n')
                          handleProviderChange((provider) => ({
                            ...provider,
                            serviceAccountPrivateKey: value
                          }))
                        }}
                        rows={4}
                        className="w-full rounded-xl px-3 py-2.5 text-sm outline-none font-mono"
                        style={inputStyle()}
                        placeholder="-----BEGIN PRIVATE KEY-----&#10;(optional — uses ADC if empty)"
                      />
                    </Field>
                  </div>
                </>
              ) : selectedProvider.type === 'openai-codex' ? (
                <>
                  <div className="col-span-2">
                    <Field label="Codex Session Path">
                      <div className="flex gap-2">
                        <input
                          value={selectedProvider.codexSessionPath ?? ''}
                          onChange={(e) =>
                            handleProviderChange((provider) => ({
                              ...provider,
                              codexSessionPath: e.target.value
                            }))
                          }
                          className="flex-1 rounded-xl px-3 py-2.5 text-sm outline-none"
                          style={inputStyle()}
                          placeholder="~/.codex/auth.json"
                        />
                        <button
                          type="button"
                          onClick={() => {
                            void (async () => {
                              const pickedPath = await window.api.yachiyo.pickCodexSessionFile()
                              if (!pickedPath) return
                              handleProviderChange((provider) => ({
                                ...provider,
                                codexSessionPath: pickedPath
                              }))
                            })()
                          }}
                          className="flex items-center gap-1.5 shrink-0 rounded-xl px-3 py-2.5 text-sm font-medium transition-opacity opacity-60 hover:opacity-100"
                          style={{ background: alpha('ink', 0.04), color: theme.text.accent }}
                          title="Select auth.json"
                        >
                          <File size={14} strokeWidth={2} />
                          Select file
                        </button>
                      </div>
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
                        onChange={(e) =>
                          handleProviderChange((provider) => ({
                            ...provider,
                            apiKey: e.target.value
                          }))
                        }
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
                        onChange={(e) =>
                          handleProviderChange((provider) => ({
                            ...provider,
                            baseUrl: e.target.value
                          }))
                        }
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
