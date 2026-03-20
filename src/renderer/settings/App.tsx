import { useEffect, useState } from 'react'
import {
  Brain,
  Cpu,
  Info,
  Loader2,
  MessageSquare,
  PanelLeft,
  Monitor,
  Plus,
  RefreshCw,
  Settings2,
  Trash2,
  X
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { DEFAULT_SIDEBAR_VISIBILITY } from '../../shared/yachiyo/protocol'
import type {
  ActiveRunEnterBehavior,
  ProviderConfig,
  ProviderKind,
  SidebarVisibility,
  SettingsConfig
} from '../../shared/yachiyo/protocol'

type TabId = 'general' | 'providers' | 'chat' | 'memory' | 'ui' | 'about'

interface SubTab {
  id: string
  label: string
}

interface Tab {
  id: TabId
  label: string
  icon: LucideIcon
  subTabs?: SubTab[]
}

const TABS: Tab[] = [
  {
    id: 'general',
    label: 'General',
    icon: Settings2,
    subTabs: [
      { id: 'appearance', label: 'Appearance' },
      { id: 'language', label: 'Language' }
    ]
  },
  { id: 'providers', label: 'Providers', icon: Cpu },
  { id: 'chat', label: 'Chat', icon: MessageSquare },
  {
    id: 'memory',
    label: 'Memory',
    icon: Brain,
    subTabs: [
      { id: 'context', label: 'Context' },
      { id: 'history', label: 'History' }
    ]
  },
  {
    id: 'ui',
    label: 'User Interface',
    icon: Monitor,
    subTabs: [
      { id: 'theme', label: 'Theme' },
      { id: 'layout', label: 'Layout' }
    ]
  },
  { id: 'about', label: 'About', icon: Info }
]

function initSubTabs(): Record<string, string> {
  const map: Record<string, string> = {}
  for (const tab of TABS) {
    if (tab.subTabs?.length) {
      map[tab.id] = tab.subTabs[0].id
    }
  }
  return map
}

function inputStyle(): React.CSSProperties {
  return {
    background: 'rgba(255,255,255,0.76)',
    border: '1px solid rgba(0,0,0,0.12)',
    color: '#2D2D2B'
  }
}

function sanitizeProvider(provider: ProviderConfig): ProviderConfig {
  return {
    ...provider,
    name: provider.name.trim(),
    apiKey: provider.apiKey.trim(),
    baseUrl: provider.baseUrl.trim(),
    modelList: {
      enabled: [...new Set(provider.modelList.enabled.filter(Boolean))],
      disabled: [...new Set(provider.modelList.disabled.filter(Boolean))]
    }
  }
}

function createProvider(existingNames: string[]): ProviderConfig {
  let index = existingNames.length + 1
  let candidate = `provider-${index}`

  while (existingNames.includes(candidate)) {
    index += 1
    candidate = `provider-${index}`
  }

  return {
    name: candidate,
    type: 'openai',
    apiKey: '',
    baseUrl: '',
    modelList: {
      enabled: [],
      disabled: []
    }
  }
}

function withSelectedProvider(
  config: SettingsConfig,
  selectedProviderName: string,
  update: (provider: ProviderConfig) => ProviderConfig
): { config: SettingsConfig; nextSelectedName: string } {
  const current = config.providers.find((provider) => provider.name === selectedProviderName)
  if (!current) {
    return { config, nextSelectedName: selectedProviderName }
  }

  const nextProvider = sanitizeProvider(update(current))

  return {
    config: {
      ...config,
      providers: config.providers.map((provider) =>
        provider.name === selectedProviderName ? nextProvider : provider
      )
    },
    nextSelectedName: nextProvider.name
  }
}

function validateConfig(config: SettingsConfig | null): string | null {
  if (!config) {
    return null
  }

  const names = config.providers.map((provider) => provider.name.trim())
  if (names.some((name) => name.length === 0)) {
    return 'Every provider needs a non-empty name.'
  }

  if (new Set(names).size !== names.length) {
    return 'Provider names must be unique.'
  }

  return null
}

function Field({ label, children }: { label: string; children: React.ReactNode }): React.ReactNode {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-sm font-medium" style={{ color: '#2D2D2B' }}>
        {label}
      </span>
      {children}
    </label>
  )
}

function PlaceholderPane({ label }: { label?: string }): React.ReactNode {
  return (
    <div className="flex-1 overflow-y-auto flex items-center justify-center">
      <div className="flex flex-col items-center gap-2.5" style={{ opacity: 0.4 }}>
        <div
          className="flex items-center justify-center rounded-full"
          style={{ width: 40, height: 40, border: '2px dashed #8e8e93' }}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            stroke="#8e8e93"
            strokeWidth="1.5"
          >
            <path d="M8 4v8M4 8h8" />
          </svg>
        </div>
        <span className="text-sm" style={{ color: '#8e8e93' }}>
          {label ?? 'Content coming soon'}
        </span>
      </div>
    </div>
  )
}

function ModelToggle({
  model,
  enabled,
  onToggle,
  onRemove
}: {
  model: string
  enabled: boolean
  onToggle: () => void
  onRemove: () => void
}): React.ReactNode {
  return (
    <div
      className="flex items-center justify-between px-3 py-2 rounded-lg transition-colors"
      style={{ background: enabled ? 'rgba(204,125,94,0.06)' : 'transparent' }}
    >
      <span className="text-sm truncate mr-3" style={{ color: '#2D2D2B' }}>
        {model}
      </span>
      <div className="flex items-center gap-2 shrink-0">
        <button
          onClick={onRemove}
          className="p-0.5 rounded opacity-0 hover:opacity-100 group-hover:opacity-40 transition-opacity"
          title="Remove model"
        >
          <X size={12} strokeWidth={1.5} color="#8e8e93" />
        </button>
        <button
          onClick={onToggle}
          className="relative w-9 h-5 rounded-full transition-colors"
          style={{ background: enabled ? '#CC7D5E' : 'rgba(0,0,0,0.12)' }}
        >
          <span
            className="absolute top-0.5 rounded-full bg-white transition-all"
            style={{
              width: 16,
              height: 16,
              left: enabled ? 19 : 2,
              boxShadow: '0 1px 3px rgba(0,0,0,0.15)'
            }}
          />
        </button>
      </div>
    </div>
  )
}

function ModelListSection({
  provider,
  onProviderChange
}: {
  provider: ProviderConfig
  onProviderChange: (update: (p: ProviderConfig) => ProviderConfig) => void
}): React.ReactNode {
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
        <span className="text-sm font-medium" style={{ color: '#2D2D2B' }}>
          Models
        </span>
        <button
          onClick={() => void handleFetch()}
          disabled={fetching || !provider.apiKey.trim()}
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium transition-opacity disabled:opacity-40"
          style={{
            background: 'rgba(204,125,94,0.1)',
            color: '#CC7D5E'
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
          border: '1px solid rgba(0,0,0,0.08)',
          background: 'rgba(255,255,255,0.5)'
        }}
      >
        {allModels.length === 0 ? (
          <div className="px-4 py-6 text-center">
            <span className="text-sm" style={{ color: '#8e8e93' }}>
              No models yet. Fetch from API or add manually.
            </span>
          </div>
        ) : (
          <div className="divide-y" style={{ borderColor: 'rgba(0,0,0,0.05)' }}>
            {provider.modelList.enabled.map((model) => (
              <div key={model} className="group">
                <ModelToggle
                  model={model}
                  enabled
                  onToggle={() => handleToggle(model)}
                  onRemove={() => handleRemoveModel(model)}
                />
              </div>
            ))}
            {provider.modelList.disabled.map((model) => (
              <div key={model} className="group">
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

        {/* Manual add */}
        <div
          className="flex items-center gap-2 px-3 py-2"
          style={{ borderTop: '1px solid rgba(0,0,0,0.06)' }}
        >
          <input
            value={manualInput}
            onChange={(e) => setManualInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                handleAddManual()
              }
            }}
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-gray-400"
            style={{ color: '#2D2D2B' }}
            placeholder="Add model name..."
          />
          <button
            onClick={handleAddManual}
            disabled={!manualInput.trim()}
            className="p-1 rounded-md transition-opacity disabled:opacity-30"
            title="Add model"
          >
            <Plus size={14} strokeWidth={2} color="#CC7D5E" />
          </button>
        </div>
      </div>

      {allModels.length > 0 ? (
        <div className="text-xs" style={{ color: '#8e8e93' }}>
          {provider.modelList.enabled.length} enabled, {provider.modelList.disabled.length} disabled
        </div>
      ) : null}

      {fetchError ? (
        <div
          className="flex items-center gap-2 rounded-xl px-3 py-2 text-xs"
          style={{ background: 'rgba(183,81,62,0.08)', color: '#8f4132' }}
        >
          <span className="shrink-0">Fetch failed:</span>
          <span className="truncate">{fetchError}</span>
          <button
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

function ProvidersPane({
  draft,
  selectedProviderName,
  onSelectProvider,
  onChange
}: {
  draft: SettingsConfig
  selectedProviderName: string
  onSelectProvider: (name: string) => void
  onChange: (next: SettingsConfig) => void
}): React.ReactNode {
  const selectedProvider =
    draft.providers.find((provider) => provider.name === selectedProviderName) ?? null

  const handleProviderChange = (update: (provider: ProviderConfig) => ProviderConfig): void => {
    if (!selectedProvider) {
      return
    }

    const next = withSelectedProvider(draft, selectedProvider.name, update)
    onChange(next.config)
    onSelectProvider(next.nextSelectedName)
  }

  const handleAddProvider = (): void => {
    const provider = createProvider(draft.providers.map((entry) => entry.name))
    onChange({
      ...draft,
      providers: [...draft.providers, provider]
    })
    onSelectProvider(provider.name)
  }

  const handleRemoveProvider = (): void => {
    if (!selectedProvider) {
      return
    }

    const providers = draft.providers.filter((provider) => provider.name !== selectedProvider.name)
    onChange({
      ...draft,
      providers
    })
    onSelectProvider(providers[0]?.name ?? '')
  }

  return (
    <div className="flex flex-1 min-h-0">
      <div
        className="shrink-0 flex flex-col"
        style={{ width: 250, borderRight: '1px solid rgba(0,0,0,0.06)', background: '#EFEEE9' }}
      >
        <div className="flex items-center justify-between px-5 py-4">
          <div>
            <div className="text-sm font-semibold" style={{ color: '#2D2D2B' }}>
              Providers
            </div>
            <div className="text-xs" style={{ color: '#8e8e93' }}>
              {draft.providers.length} configured
            </div>
          </div>
          <button
            onClick={handleAddProvider}
            className="flex items-center gap-1 rounded-full px-2.5 py-1.5 text-xs font-medium"
            style={{ background: '#CC7D5E', color: '#fff' }}
          >
            <Plus size={12} strokeWidth={2} />
            Add
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-3 pb-4">
          {draft.providers.map((provider) => {
            const isSelected = provider.name === selectedProviderName

            return (
              <button
                key={provider.name}
                onClick={() => onSelectProvider(provider.name)}
                className="mb-2 w-full rounded-2xl px-3 py-3 text-left transition-all"
                style={
                  isSelected
                    ? {
                        background: 'rgba(255,255,255,0.82)',
                        boxShadow: '0 6px 18px rgba(0,0,0,0.08)'
                      }
                    : {
                        background: 'rgba(255,255,255,0.46)'
                      }
                }
              >
                <div className="min-w-0">
                  <div
                    className="truncate text-sm font-semibold"
                    style={{ color: '#2D2D2B', letterSpacing: '-0.2px' }}
                  >
                    {provider.name}
                  </div>
                  <div className="text-xs uppercase tracking-[0.14em]" style={{ color: '#8e8e93' }}>
                    {provider.type}
                  </div>
                </div>
                <div className="mt-3 text-xs" style={{ color: '#6b6a66' }}>
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
                style={{ color: '#2D2D2B', letterSpacing: '-0.4px' }}
              >
                {selectedProvider.name}
              </div>

              <button
                onClick={handleRemoveProvider}
                className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium"
                style={{ background: 'rgba(183,81,62,0.1)', color: '#8f4132' }}
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
                    placeholder={selectedProvider.type === 'anthropic' ? 'sk-ant-...' : 'sk-...'}
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

function GeneralPane({
  activeSubTab,
  draft,
  onChange
}: {
  activeSubTab: string
  draft: SettingsConfig
  onChange: (next: SettingsConfig) => void
}): React.ReactNode {
  if (activeSubTab !== 'appearance') {
    return <PlaceholderPane label="Language settings coming soon." />
  }

  const sidebarVisibility = draft.general?.sidebarVisibility ?? DEFAULT_SIDEBAR_VISIBILITY
  const options: Array<{
    description: string
    helper: string
    icon: typeof PanelLeft
    value: SidebarVisibility
  }> = [
    {
      value: 'expanded',
      description: 'Show the sidebar when the app opens',
      helper: 'Keeps the thread list visible immediately after launch.',
      icon: PanelLeft
    },
    {
      value: 'collapsed',
      description: 'Start with the sidebar hidden',
      helper: 'Leaves more room for chat and keeps an expand button in the title bar.',
      icon: PanelLeft
    }
  ]

  return (
    <div className="flex-1 overflow-y-auto px-7 py-6">
      <div className="max-w-3xl space-y-6">
        <div className="space-y-1">
          <h2
            className="text-2xl font-semibold"
            style={{ color: '#2D2D2B', letterSpacing: '-0.4px' }}
          >
            Window layout
          </h2>
          <p className="text-sm leading-6" style={{ color: '#6b6a66' }}>
            Choose how the main window should open by default. The sidebar toggle in chat will
            keep this preference in sync.
          </p>
        </div>

        <div className="space-y-3">
          {options.map((option) => {
            const isSelected = option.value === sidebarVisibility
            const Icon = option.icon

            return (
              <button
                key={option.value}
                type="button"
                onClick={() =>
                  onChange({
                    ...draft,
                    general: {
                      ...draft.general,
                      sidebarVisibility: option.value
                    }
                  })
                }
                className="w-full rounded-2xl px-5 py-4 text-left transition-all"
                style={{
                  background: isSelected ? 'rgba(255,255,255,0.92)' : 'rgba(255,255,255,0.58)',
                  border: isSelected
                    ? '1px solid rgba(204,125,94,0.26)'
                    : '1px solid rgba(0,0,0,0.08)',
                  boxShadow: isSelected ? '0 10px 24px rgba(0,0,0,0.08)' : 'none'
                }}
              >
                <div className="flex items-start gap-3">
                  <span
                    className="mt-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl"
                    style={{
                      background: isSelected ? 'rgba(204,125,94,0.12)' : 'rgba(0,0,0,0.05)',
                      color: isSelected ? '#B56A4A' : '#6b6a66'
                    }}
                  >
                    <Icon size={16} strokeWidth={1.7} />
                  </span>
                  <div className="space-y-1">
                    <div className="text-sm font-semibold" style={{ color: '#2D2D2B' }}>
                      {option.description}
                    </div>
                    <div className="text-sm leading-6" style={{ color: '#6b6a66' }}>
                      {option.helper}
                    </div>
                  </div>
                  <span
                    className="ml-auto mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full"
                    style={{
                      border: isSelected ? '5px solid #CC7D5E' : '1px solid rgba(0,0,0,0.18)',
                      background: '#fff'
                    }}
                  />
                </div>
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function ChatPane({
  draft,
  onChange
}: {
  draft: SettingsConfig
  onChange: (next: SettingsConfig) => void
}): React.ReactNode {
  const activeRunEnterBehavior = draft.chat?.activeRunEnterBehavior ?? 'enter-steers'
  const options: Array<{
    description: string
    helper: string
    value: ActiveRunEnterBehavior
  }> = [
    {
      value: 'enter-steers',
      description: 'Enter steers, Alt+Enter queues follow-up',
      helper: 'Fastest steering path while a reply is still running.'
    },
    {
      value: 'enter-queues-follow-up',
      description: 'Alt+Enter steers, Enter queues follow-up',
      helper: 'Protect plain Enter from accidental steering during long replies.'
    }
  ]

  return (
    <div className="flex-1 overflow-y-auto px-7 py-6">
      <div className="max-w-3xl space-y-6">
        <div className="space-y-1">
          <h2
            className="text-2xl font-semibold"
            style={{ color: '#2D2D2B', letterSpacing: '-0.4px' }}
          >
            When a reply is still running
          </h2>
          <p className="text-sm leading-6" style={{ color: '#6b6a66' }}>
            Choose what plain Enter does while a thread already has an active run. Shift+Enter
            always inserts a newline.
          </p>
        </div>

        <div className="space-y-3">
          {options.map((option) => {
            const isSelected = option.value === activeRunEnterBehavior

            return (
              <button
                key={option.value}
                type="button"
                onClick={() =>
                  onChange({
                    ...draft,
                    chat: {
                      activeRunEnterBehavior: option.value
                    }
                  })
                }
                className="w-full rounded-2xl px-5 py-4 text-left transition-all"
                style={{
                  background: isSelected ? 'rgba(255,255,255,0.92)' : 'rgba(255,255,255,0.58)',
                  border: isSelected
                    ? '1px solid rgba(204,125,94,0.26)'
                    : '1px solid rgba(0,0,0,0.08)',
                  boxShadow: isSelected ? '0 10px 24px rgba(0,0,0,0.08)' : 'none'
                }}
              >
                <div className="flex items-start gap-3">
                  <span
                    className="mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full"
                    style={{
                      border: isSelected ? '5px solid #CC7D5E' : '1px solid rgba(0,0,0,0.18)',
                      background: '#fff'
                    }}
                  />
                  <div className="space-y-1">
                    <div className="text-sm font-semibold" style={{ color: '#2D2D2B' }}>
                      {option.description}
                    </div>
                    <div className="text-sm leading-6" style={{ color: '#6b6a66' }}>
                      {option.helper}
                    </div>
                  </div>
                </div>
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function SettingsApp(): React.ReactNode {
  const [activeTab, setActiveTab] = useState<TabId>('providers')
  const [activeSubTab, setActiveSubTab] = useState(initSubTabs)
  const [savedConfig, setSavedConfig] = useState<SettingsConfig | null>(null)
  const [draft, setDraft] = useState<SettingsConfig | null>(null)
  const [selectedProviderName, setSelectedProviderName] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    void window.api.yachiyo
      .getConfig()
      .then((config) => {
        if (cancelled) {
          return
        }

        setSavedConfig(config)
        setDraft(config)
        setSelectedProviderName(config.providers[0]?.name || '')
        setLoading(false)
      })
      .catch((reason) => {
        if (cancelled) {
          return
        }

        setError(reason instanceof Error ? reason.message : 'Failed to load settings.')
        setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!draft) {
      return
    }

    if (draft.providers.some((provider) => provider.name === selectedProviderName)) {
      return
    }

    setSelectedProviderName(draft.providers[0]?.name || '')
  }, [draft, selectedProviderName])

  const active = TABS.find((tab) => tab.id === activeTab)!
  const ActiveIcon = active.icon
  const validationError = validateConfig(draft)
  const isDirty = JSON.stringify(savedConfig) !== JSON.stringify(draft)

  const handleSave = async (): Promise<void> => {
    if (!draft || saving || validationError) {
      return
    }

    setSaving(true)
    setError(null)

    try {
      const next = await window.api.yachiyo.saveConfig(draft)
      setSavedConfig(next)
      setDraft(next)
      setSelectedProviderName(next.providers[0]?.name || '')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Failed to save settings.')
    } finally {
      setSaving(false)
    }
  }

  let body: React.ReactNode = (
    <PlaceholderPane
      label={
        active.subTabs
          ? `${active.label} -> ${active.subTabs.find((item) => item.id === activeSubTab[active.id])?.label}`
          : undefined
      }
    />
  )

  if (loading) {
    body = (
      <div className="flex-1 overflow-y-auto flex items-center justify-center">
        <span className="text-sm" style={{ color: '#8e8e93' }}>
          Loading settings...
        </span>
      </div>
    )
  } else if (draft) {
    if (activeTab === 'general') {
      body = (
        <GeneralPane
          activeSubTab={activeSubTab.general ?? 'appearance'}
          draft={draft}
          onChange={setDraft}
        />
      )
    } else if (activeTab === 'providers') {
      body = (
        <ProvidersPane
          draft={draft}
          selectedProviderName={selectedProviderName}
          onSelectProvider={setSelectedProviderName}
          onChange={setDraft}
        />
      )
    } else if (activeTab === 'chat') {
      body = <ChatPane draft={draft} onChange={setDraft} />
    }
  }

  return (
    <div className="flex h-full overflow-hidden">
      <div
        className="flex flex-col shrink-0"
        style={{ width: '210px', background: '#E8E7E3', borderRight: '1px solid rgba(0,0,0,0.08)' }}
      >
        <div className="drag-region shrink-0 flex items-center px-4" style={{ height: '52px' }}>
          <span className="font-bold text-lg" style={{ color: '#2D2D2B', letterSpacing: '-0.3px' }}>
            Settings
          </span>
        </div>

        <nav className="flex-1 px-2 py-1 overflow-y-auto no-drag">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setActiveTab(id)}
              className="w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg text-sm text-left mb-0.5 transition-all"
              style={
                activeTab === id
                  ? {
                      background: 'rgba(255,255,255,0.75)',
                      color: '#2D2D2B',
                      fontWeight: 500,
                      boxShadow: '0 1px 3px rgba(0,0,0,0.08)'
                    }
                  : { color: '#3a3a3c' }
              }
            >
              <Icon
                size={16}
                strokeWidth={1.5}
                style={{ opacity: activeTab === id ? 1 : 0.65, flexShrink: 0 }}
              />
              {label}
            </button>
          ))}
        </nav>
      </div>

      <div className="flex flex-col flex-1 min-w-0" style={{ background: '#F9F9F7' }}>
        <div
          className="shrink-0 flex items-center gap-2.5 drag-region"
          style={{ height: '52px', padding: '0 28px', borderBottom: '1px solid rgba(0,0,0,0.07)' }}
        >
          <ActiveIcon size={20} strokeWidth={1.5} style={{ color: '#2D2D2B', opacity: 0.75 }} />
          <span
            className="font-semibold text-xl"
            style={{ color: '#2D2D2B', letterSpacing: '-0.3px' }}
          >
            {active.label}
          </span>
        </div>

        {active.subTabs ? (
          <div
            className="shrink-0 no-drag flex items-center gap-1 px-7"
            style={{ borderBottom: '1px solid rgba(0,0,0,0.07)' }}
          >
            {active.subTabs.map((subTab) => {
              const isActive = activeSubTab[active.id] === subTab.id
              return (
                <button
                  key={subTab.id}
                  onClick={() =>
                    setActiveSubTab((current) => ({ ...current, [active.id]: subTab.id }))
                  }
                  className="relative px-3 py-2.5 text-sm font-medium transition-colors"
                  style={{ color: isActive ? '#2D2D2B' : '#8e8e93' }}
                >
                  {subTab.label}
                  {isActive ? (
                    <span
                      className="absolute bottom-0 left-3 right-3"
                      style={{ height: 2, background: '#2D2D2B', borderRadius: 1 }}
                    />
                  ) : null}
                </button>
              )
            })}
          </div>
        ) : null}

        {body}

        <div
          className="shrink-0 no-drag flex items-center justify-between px-5 py-3"
          style={{ borderTop: '1px solid rgba(0,0,0,0.08)' }}
        >
          <span
            className="text-xs"
            style={{ color: error || validationError ? '#8f4132' : '#8e8e93' }}
          >
            {validationError
              ? validationError
              : error
                ? error
                : saving
                  ? 'Saving changes...'
                  : isDirty
                    ? 'Unsaved changes'
                    : 'All changes saved'}
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => window.close()}
              className="px-4 py-1.5 rounded-lg text-sm font-medium"
              style={{
                background: 'rgba(255,255,255,0.8)',
                border: '1px solid rgba(0,0,0,0.15)',
                color: '#2D2D2B',
                cursor: 'pointer'
              }}
            >
              Close
            </button>
            <button
              onClick={() => void handleSave()}
              disabled={!isDirty || saving || loading || !draft || Boolean(validationError)}
              className="px-4 py-1.5 rounded-lg text-sm font-medium"
              style={{
                background:
                  !isDirty || saving || loading || !draft || validationError
                    ? '#8e8e93'
                    : '#CC7D5E',
                color: '#fff',
                opacity: !isDirty || saving || loading || !draft || validationError ? 0.4 : 1,
                border: '1px solid transparent',
                cursor:
                  !isDirty || saving || loading || !draft || validationError
                    ? 'not-allowed'
                    : 'pointer'
              }}
            >
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

export default SettingsApp
