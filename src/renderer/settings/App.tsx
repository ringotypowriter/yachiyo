import { useEffect, useState } from 'react'
import {
  Bot,
  Brain,
  Clock,
  Compass,
  Cpu,
  FolderOpen,
  Grid2X2,
  Hash,
  Info,
  MessageSquare,
  Monitor,
  Radio,
  Sparkles,
  Settings2
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { theme } from '@renderer/theme/theme'
import type { SettingsConfig } from '../../shared/yachiyo/protocol.ts'
import type { SkillCatalogEntry } from '../../shared/yachiyo/protocol.ts'
import {
  getToolModelConfig,
  resolveToolModelProvider
} from '../../shared/yachiyo/providerConfig.ts'
import { PlaceholderPane } from './components/primitives'
import { ChatPane } from './panes/ChatPane'
import { GeneralPane } from './panes/GeneralPane'
import { MemoryPane } from './panes/MemoryPane'
import { ProvidersPane } from './panes/ProvidersPane'
import { SearchPane } from './panes/SearchPane'
import { PromptsPane } from './panes/PromptsPane'
import { CodingAgentsPane } from './panes/CodingAgentsPane'
import { SkillsPane } from './panes/SkillsPane'
import { UIPane } from './panes/UIPane'
import { WorkspacePane } from './panes/WorkspacePane'
import { AboutPane } from './panes/AboutPane'
import { ChannelsPane } from './panes/ChannelsPane'
import { EssentialsPane } from './panes/EssentialsPane'
import { SchedulePane } from './panes/SchedulePane'

type TabId =
  | 'general'
  | 'providers'
  | 'chat'
  | 'essentials'
  | 'skills'
  | 'coding-agents'
  | 'prompts'
  | 'workspace'
  | 'search'
  | 'memory'
  | 'channels'
  | 'schedules'
  | 'ui'
  | 'about'

interface SubTab {
  id: string
  label: string
}

interface Tab {
  id: TabId
  icon: LucideIcon
  label: string
  subTabs?: SubTab[]
}

const TABS: Tab[] = [
  { id: 'general', label: 'General', icon: Settings2 },
  { id: 'providers', label: 'Providers', icon: Cpu },
  { id: 'chat', label: 'Chat', icon: MessageSquare },
  { id: 'essentials', label: 'Essentials', icon: Grid2X2 },
  { id: 'skills', label: 'Skills', icon: Sparkles },
  { id: 'coding-agents', label: 'Coding', icon: Bot },
  { id: 'prompts', label: 'Prompts', icon: Hash },
  { id: 'workspace', label: 'Workspace', icon: FolderOpen },
  { id: 'search', label: 'Search', icon: Compass },
  {
    id: 'memory',
    label: 'Memory',
    icon: Brain
  },
  {
    id: 'channels',
    label: 'Channels',
    icon: Radio,
    subTabs: [
      { id: 'general', label: 'General' },
      { id: 'telegram', label: 'Telegram' },
      { id: 'qq', label: 'QQ' },
      { id: 'discord', label: 'Discord' }
    ]
  },
  {
    id: 'schedules',
    label: 'Schedules',
    icon: Clock,
    subTabs: [
      { id: 'list', label: 'Schedules' },
      { id: 'history', label: 'History' }
    ]
  },
  { id: 'ui', label: 'User Interface', icon: Monitor },
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

  const toolModel = getToolModelConfig(config)
  if (toolModel.mode === 'custom') {
    if (!toolModel.providerId.trim() && !toolModel.providerName.trim()) {
      return 'Choose a provider for the tool model.'
    }

    if (!resolveToolModelProvider(config, toolModel)) {
      return 'The tool model provider must exist.'
    }

    if (!toolModel.model.trim()) {
      return 'Choose a model for the tool model.'
    }
  }

  if (
    config.memory?.enabled &&
    config.memory.provider === 'nowledge-mem' &&
    !config.memory.baseUrl?.trim()
  ) {
    return 'Choose a Nowledge Mem backend URL before enabling Memory.'
  }

  return null
}

function SettingsApp(): React.ReactNode {
  const [activeTab, setActiveTab] = useState<TabId>('general')
  const [activeSubTab, setActiveSubTab] = useState(initSubTabs)
  const [savedConfig, setSavedConfig] = useState<SettingsConfig | null>(null)
  const [draft, setDraft] = useState<SettingsConfig | null>(null)
  const [selectedProviderId, setSelectedProviderId] = useState('')
  const [availableSkills, setAvailableSkills] = useState<SkillCatalogEntry[]>([])
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
        setSelectedProviderId(config.providers[0]?.id ?? '')
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

    let cancelled = false

    void window.api.yachiyo
      .listSkills({ workspacePaths: draft.workspace?.savedPaths ?? [] })
      .then((skills) => {
        if (!cancelled) {
          setAvailableSkills(skills)
        }
      })
      .catch((reason) => {
        if (!cancelled) {
          console.warn('[yachiyo][settings] failed to load skills', reason)
          setAvailableSkills([])
        }
      })

    return () => {
      cancelled = true
    }
  }, [draft])

  useEffect(() => {
    if (!draft) {
      return
    }

    if (draft.providers.some((provider) => provider.id === selectedProviderId)) {
      return
    }

    setSelectedProviderId(draft.providers[0]?.id ?? '')
  }, [draft, selectedProviderId])

  const active = TABS.find((tab) => tab.id === activeTab)!
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
      setSelectedProviderId((current) =>
        next.providers.some((provider) => provider.id === current)
          ? current
          : (next.providers[0]?.id ?? '')
      )

      // Sync update channel to the running auto-updater after persisting
      const channel = next.general?.updateChannel ?? 'stable'
      window.api.appUpdate.setChannel(channel)
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
        <span className="text-sm" style={{ color: theme.text.muted }}>
          Loading settings...
        </span>
      </div>
    )
  } else if (draft) {
    if (activeTab === 'general') {
      body = <GeneralPane draft={draft} onChange={setDraft} />
    } else if (activeTab === 'providers') {
      body = (
        <ProvidersPane
          draft={draft}
          selectedProviderId={selectedProviderId}
          onSelectProvider={setSelectedProviderId}
          onChange={setDraft}
        />
      )
    } else if (activeTab === 'chat') {
      body = <ChatPane draft={draft} onChange={setDraft} />
    } else if (activeTab === 'essentials') {
      body = <EssentialsPane draft={draft} onChange={setDraft} />
    } else if (activeTab === 'skills') {
      body = <SkillsPane availableSkills={availableSkills} draft={draft} onChange={setDraft} />
    } else if (activeTab === 'coding-agents') {
      body = <CodingAgentsPane draft={draft} onChange={setDraft} />
    } else if (activeTab === 'prompts') {
      body = <PromptsPane draft={draft} onChange={setDraft} />
    } else if (activeTab === 'workspace') {
      body = <WorkspacePane draft={draft} onChange={setDraft} />
    } else if (activeTab === 'search') {
      body = <SearchPane draft={draft} onChange={setDraft} />
    } else if (activeTab === 'memory') {
      body = <MemoryPane draft={draft} onChange={setDraft} />
    } else if (activeTab === 'channels') {
      body = <ChannelsPane activeSubTab={activeSubTab['channels'] ?? 'general'} />
    } else if (activeTab === 'schedules') {
      body = (
        <SchedulePane
          activeSubTab={activeSubTab['schedules'] ?? 'list'}
          onNavigateToTab={(tab) => setActiveTab(tab as TabId)}
        />
      )
    } else if (activeTab === 'ui') {
      body = <UIPane draft={draft} onChange={setDraft} />
    }
  }

  if (activeTab === 'about') {
    body = <AboutPane />
  }

  return (
    <div className="flex h-full overflow-hidden">
      <div
        className="flex flex-col shrink-0"
        style={{
          width: '210px',
          background: theme.background.sidebar,
          borderRight: `1px solid ${theme.border.panel}`
        }}
      >
        <div className="drag-region shrink-0 flex items-center px-4" style={{ height: '52px' }}>
          <span
            className="font-bold text-lg"
            style={{ color: theme.text.primary, letterSpacing: '-0.3px' }}
          >
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
                      background: theme.background.accentSoft,
                      color: theme.text.accent,
                      fontWeight: 500
                    }
                  : { color: theme.text.secondary }
              }
            >
              <Icon
                size={16}
                strokeWidth={1.5}
                style={{ opacity: activeTab === id ? 1 : 0.6, flexShrink: 0 }}
              />
              {label}
            </button>
          ))}
        </nav>
      </div>

      <div
        className="flex flex-col flex-1 min-w-0"
        style={{ background: theme.background.surface }}
      >
        <div
          className="shrink-0 flex items-center drag-region"
          style={{
            height: '52px',
            padding: '0 28px',
            borderBottom: `1px solid ${theme.border.panel}`
          }}
        >
          <span
            className="font-semibold text-xl"
            style={{ color: theme.text.primary, letterSpacing: '-0.3px' }}
          >
            {active.label}
          </span>
        </div>

        {active.subTabs ? (
          <div
            className="shrink-0 no-drag flex items-center gap-1 px-7"
            style={{ borderBottom: `1px solid ${theme.border.panel}` }}
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
                  style={{ color: isActive ? theme.text.primary : theme.text.muted }}
                >
                  {subTab.label}
                  {isActive ? (
                    <span
                      className="absolute bottom-0 left-3 right-3"
                      style={{ height: 2, background: theme.text.primary, borderRadius: 1 }}
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
          style={{ borderTop: `1px solid ${theme.border.panel}` }}
        >
          <span
            className="text-xs"
            style={{
              minHeight: 16,
              lineHeight: '16px',
              color: error || validationError ? theme.text.dangerStrong : theme.text.muted,
              visibility: isDirty || saving || error || validationError ? 'visible' : 'hidden'
            }}
          >
            {validationError
              ? validationError
              : error
                ? error
                : saving
                  ? 'Saving...'
                  : 'Unsaved changes'}
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => window.close()}
              className="px-4 py-1.5 rounded-lg text-sm font-medium transition-opacity opacity-60 hover:opacity-100"
              style={{
                background: 'transparent',
                border: 'none',
                color: theme.text.secondary,
                cursor: 'pointer'
              }}
            >
              Close
            </button>
            <button
              onClick={() => void handleSave()}
              disabled={!isDirty || saving || loading || !draft || Boolean(validationError)}
              className="px-4 py-1.5 rounded-lg text-sm font-medium transition-all"
              style={{
                minHeight: 36,
                border: '1px solid transparent',
                ...(!isDirty || saving || loading || !draft || validationError
                  ? {
                      background: 'transparent',
                      color: theme.text.muted,
                      cursor: 'not-allowed',
                      opacity: 0.4
                    }
                  : {
                      background: theme.text.accent,
                      color: theme.text.inverse,
                      cursor: 'pointer'
                    })
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
