import { useEffect, useState } from 'react'
import { Brain, Cpu, Info, MessageSquare, Monitor, Plus, Settings2, Trash2 } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { ProviderConfig, ProviderKind, SettingsConfig } from '../../shared/yachiyo/protocol'

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

function inputStyle() {
  return {
    background: 'rgba(255,255,255,0.76)',
    border: '1px solid rgba(0,0,0,0.12)',
    color: '#1c1c1e'
  }
}

function normalizeLines(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[\n,]/u)
        .map((item) => item.trim())
        .filter(Boolean)
    )
  ]
}

function formatLines(values: string[]): string {
  return values.join('\n')
}

function sanitizeProvider(provider: ProviderConfig): ProviderConfig {
  const enabled = normalizeLines(provider.modelList.enabled.join('\n'))
  const disabled = normalizeLines(provider.modelList.disabled.join('\n')).filter(
    (model) => !enabled.includes(model)
  )

  return {
    ...provider,
    name: provider.name.trim(),
    apiKey: provider.apiKey.trim(),
    baseUrl: provider.baseUrl.trim(),
    modelList: {
      enabled,
      disabled
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

function Field({
  label,
  children,
  hint
}: {
  label: string
  children: React.ReactNode
  hint?: string
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-sm font-medium" style={{ color: '#1c1c1e' }}>
        {label}
      </span>
      {children}
      {hint ? (
        <span className="text-xs" style={{ color: '#8e8e93' }}>
          {hint}
        </span>
      ) : null}
    </label>
  )
}

function PlaceholderPane({ label }: { label?: string }) {
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
}) {
  const selectedProvider =
    draft.providers.find((provider) => provider.name === selectedProviderName) ?? null

  const handleProviderChange = (update: (provider: ProviderConfig) => ProviderConfig) => {
    if (!selectedProvider) {
      return
    }

    const next = withSelectedProvider(draft, selectedProvider.name, update)
    onChange(next.config)
    onSelectProvider(next.nextSelectedName)
  }

  const handleAddProvider = () => {
    const provider = createProvider(draft.providers.map((entry) => entry.name))
    onChange({
      ...draft,
      providers: [...draft.providers, provider]
    })
    onSelectProvider(provider.name)
  }

  const handleRemoveProvider = () => {
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
        style={{ width: 250, borderRight: '1px solid rgba(0,0,0,0.06)', background: '#efede7' }}
      >
        <div className="flex items-center justify-between px-5 py-4">
          <div>
            <div className="text-sm font-semibold" style={{ color: '#1c1c1e' }}>
              Providers
            </div>
            <div className="text-xs" style={{ color: '#8e8e93' }}>
              {draft.providers.length} configured
            </div>
          </div>
          <button
            onClick={handleAddProvider}
            className="flex items-center gap-1 rounded-full px-2.5 py-1.5 text-xs font-medium"
            style={{ background: '#4a7876', color: '#fff' }}
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
                    style={{ color: '#1c1c1e', letterSpacing: '-0.2px' }}
                  >
                    {provider.name}
                  </div>
                  <div className="text-xs uppercase tracking-[0.14em]" style={{ color: '#8e8e93' }}>
                    {provider.type}
                  </div>
                </div>
                <div className="mt-3 text-xs" style={{ color: '#6b6a66' }}>
                  {provider.modelList.enabled.length} visible models
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
              <div>
                <div
                  className="text-2xl font-semibold"
                  style={{ color: '#1c1c1e', letterSpacing: '-0.4px' }}
                >
                  {selectedProvider.name}
                </div>
                <div className="mt-1 text-sm" style={{ color: '#8e8e93' }}>
                  {selectedProvider.type === 'anthropic'
                    ? 'Anthropic-compatible endpoint'
                    : 'OpenAI-compatible endpoint'}
                </div>
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
              <Field label="Name" hint="Unique key used to identify this provider in config.">
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

              <Field label="Type" hint="Chooses the runtime adapter for this provider.">
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
                <Field label="API Key" hint="Stored locally in the TOML config file.">
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
                <Field
                  label="Base URL"
                  hint="Leave blank for the official endpoint. Set this only for a custom gateway."
                >
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

              <Field
                label="Enabled Models"
                hint="These models are exposed to the external model picker."
              >
                <textarea
                  value={formatLines(selectedProvider.modelList.enabled)}
                  onChange={(event) =>
                    handleProviderChange((provider) => ({
                      ...provider,
                      modelList: {
                        ...provider.modelList,
                        enabled: normalizeLines(event.target.value)
                      }
                    }))
                  }
                  className="min-h-44 w-full rounded-2xl px-3 py-3 text-sm outline-none resize-y"
                  style={inputStyle()}
                  placeholder={
                    selectedProvider.type === 'anthropic'
                      ? 'claude-opus-4-6\nclaude-sonnet-4-5'
                      : 'gpt-5\ngpt-4.1'
                  }
                />
              </Field>

              <Field
                label="Disabled Models"
                hint="Kept in config, but hidden from the external picker."
              >
                <textarea
                  value={formatLines(selectedProvider.modelList.disabled)}
                  onChange={(event) =>
                    handleProviderChange((provider) => ({
                      ...provider,
                      modelList: {
                        ...provider.modelList,
                        disabled: normalizeLines(event.target.value)
                      }
                    }))
                  }
                  className="min-h-44 w-full rounded-2xl px-3 py-3 text-sm outline-none resize-y"
                  style={inputStyle()}
                  placeholder={
                    selectedProvider.type === 'anthropic'
                      ? 'claude-3-5-haiku-latest'
                      : 'o3-mini\ngpt-4o-mini'
                  }
                />
              </Field>
            </div>

            <div
              className="rounded-2xl px-4 py-3"
              style={{
                background: 'rgba(74,120,118,0.08)',
                border: '1px solid rgba(74,120,118,0.14)'
              }}
            >
              <div className="text-sm font-medium" style={{ color: '#264f4e' }}>
                Model picker behavior
              </div>
              <div className="mt-1 text-sm" style={{ color: '#466563' }}>
                Only models from the enabled list are visible in the external picker. Disabled
                models remain in config for later reuse.
              </div>
            </div>
          </div>
        ) : (
          <PlaceholderPane label="Add your first provider to start wiring model access." />
        )}
      </div>
    </div>
  )
}

function SettingsApp() {
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

  const handleSave = async () => {
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
    if (activeTab === 'providers') {
      body = (
        <ProvidersPane
          draft={draft}
          selectedProviderName={selectedProviderName}
          onSelectProvider={setSelectedProviderName}
          onChange={setDraft}
        />
      )
    } else if (activeTab === 'chat') {
      body = <PlaceholderPane label="Chat settings coming soon." />
    }
  }

  return (
    <div className="flex h-full overflow-hidden">
      <div
        className="flex flex-col shrink-0"
        style={{ width: '210px', background: '#e8e6e1', borderRight: '1px solid rgba(0,0,0,0.08)' }}
      >
        <div className="drag-region shrink-0 flex items-center px-4" style={{ height: '52px' }}>
          <span className="font-bold text-lg" style={{ color: '#1c1c1e', letterSpacing: '-0.3px' }}>
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
                      color: '#1c1c1e',
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

      <div className="flex flex-col flex-1 min-w-0" style={{ background: '#f5f4f0' }}>
        <div
          className="shrink-0 flex items-center gap-2.5 drag-region"
          style={{ height: '52px', padding: '0 28px', borderBottom: '1px solid rgba(0,0,0,0.07)' }}
        >
          <ActiveIcon size={20} strokeWidth={1.5} style={{ color: '#1c1c1e', opacity: 0.75 }} />
          <span
            className="font-semibold text-xl"
            style={{ color: '#1c1c1e', letterSpacing: '-0.3px' }}
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
                  style={{ color: isActive ? '#1c1c1e' : '#8e8e93' }}
                >
                  {subTab.label}
                  {isActive ? (
                    <span
                      className="absolute bottom-0 left-3 right-3"
                      style={{ height: 2, background: '#1c1c1e', borderRadius: 1 }}
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
                color: '#1c1c1e',
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
                    : '#4a7876',
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
