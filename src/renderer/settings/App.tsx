import { useCallback, useEffect, useRef, useState } from 'react'
import {
  BarChart3,
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
import type {
  ChannelGroupRecord,
  ChannelUserRecord,
  ChannelsConfig,
  SettingsConfig,
  SkillCatalogEntry,
  SoulDocument,
  UserDocument
} from '../../shared/yachiyo/protocol.ts'
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
import { UsagePane } from './panes/UsagePane'
import {
  hasPendingChannelGroupChanges,
  hasPendingChannelUserChanges,
  persistChannelGroupDrafts,
  persistChannelUserDrafts,
  sanitizeChannelsConfig
} from './panes/channelsPaneModel'
import {
  hasPendingSoulDocumentChanges,
  loadSoulDocument,
  persistSoulDocument
} from './panes/soulDocumentEditorModel'
import {
  hasPendingUserDocumentChanges,
  loadUserDocument,
  persistUserDocument
} from './panes/userDocumentEditorModel'

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
  | 'usage'
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
      { id: 'qqbot', label: 'QQBot' },
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
  { id: 'usage', label: 'Usage', icon: BarChart3 },
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

  const translatorShortcut = config.general?.translatorShortcut?.trim() ?? ''
  const jotdownShortcut = config.general?.jotdownShortcut?.trim() ?? ''
  if (
    translatorShortcut &&
    jotdownShortcut &&
    translatorShortcut.toLowerCase() === jotdownShortcut.toLowerCase()
  ) {
    return 'Translator and Jot Down shortcuts cannot be the same.'
  }

  return null
}

function SettingsApp(): React.ReactNode {
  const [activeTab, setActiveTab] = useState<TabId>(() => {
    const hash = window.location.hash.slice(1)
    return (TABS.some((t) => t.id === hash) ? hash : 'general') as TabId
  })
  const [activeSubTab, setActiveSubTab] = useState(initSubTabs)
  const [savedConfig, setSavedConfig] = useState<SettingsConfig | null>(null)
  const [draft, setDraft] = useState<SettingsConfig | null>(null)
  const [savedChannelsConfig, setSavedChannelsConfig] = useState<ChannelsConfig | null>(null)
  const [channelsDraft, setChannelsDraft] = useState<ChannelsConfig | null>(null)
  const [isLoadingChannelsConfig, setIsLoadingChannelsConfig] = useState(true)
  const [channelsConfigError, setChannelsConfigError] = useState<string | null>(null)
  const [savedUserDocument, setSavedUserDocument] = useState<UserDocument | null>(null)
  const [userDocumentDraft, setUserDocumentDraft] = useState<string | null>(null)
  const [isLoadingUserDocument, setIsLoadingUserDocument] = useState(false)
  const [userDocumentError, setUserDocumentError] = useState<string | null>(null)
  const [savedSoulDocument, setSavedSoulDocument] = useState<SoulDocument | null>(null)
  const [soulDocumentDraft, setSoulDocumentDraft] = useState<string[] | null>(null)
  const [isLoadingSoulDocument, setIsLoadingSoulDocument] = useState(false)
  const [soulDocumentError, setSoulDocumentError] = useState<string | null>(null)
  const [savedChannelUsers, setSavedChannelUsers] = useState<ChannelUserRecord[] | null>(null)
  const [channelUsersDraft, setChannelUsersDraft] = useState<ChannelUserRecord[] | null>(null)
  const [savedChannelGroups, setSavedChannelGroups] = useState<ChannelGroupRecord[] | null>(null)
  const [channelGroupsDraft, setChannelGroupsDraft] = useState<ChannelGroupRecord[] | null>(null)
  const [isLoadingChannelRecords, setIsLoadingChannelRecords] = useState(false)
  const [channelRecordsError, setChannelRecordsError] = useState<string | null>(null)
  const [selectedProviderId, setSelectedProviderId] = useState('')
  const [availableSkills, setAvailableSkills] = useState<SkillCatalogEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const previousActiveTabRef = useRef<TabId | null>(null)

  useEffect(() => {
    const handler = (_event: Electron.IpcRendererEvent, tab: string): void => {
      if (TABS.some((t) => t.id === tab)) {
        setActiveTab(tab as TabId)
      }
    }
    window.electron.ipcRenderer.on('navigate-settings-to', handler)
    return () => {
      window.electron.ipcRenderer.removeListener('navigate-settings-to', handler)
    }
  }, [])

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

    void window.api.yachiyo
      .getChannelsConfig()
      .then((channelsConfig) => {
        if (cancelled) {
          return
        }

        setChannelsConfigError(null)
        setSavedChannelsConfig(channelsConfig)
        setChannelsDraft(channelsConfig)
        setIsLoadingChannelsConfig(false)
      })
      .catch((reason) => {
        if (cancelled) {
          return
        }

        console.warn('[yachiyo][settings] failed to load channels config', reason)
        setChannelsConfigError(
          reason instanceof Error ? reason.message : 'Failed to load channels settings.'
        )
        setIsLoadingChannelsConfig(false)
      })

    return () => {
      cancelled = true
    }
  }, [])

  const loadUserDocumentDraft = useCallback(async (): Promise<void> => {
    if (isLoadingUserDocument) {
      return
    }

    setIsLoadingUserDocument(true)
    setUserDocumentError(null)

    try {
      const document = await loadUserDocument()
      setSavedUserDocument(document)
      setUserDocumentDraft(document.content)
    } catch (reason) {
      setUserDocumentError(reason instanceof Error ? reason.message : 'Failed to load USER.md.')
    } finally {
      setIsLoadingUserDocument(false)
    }
  }, [isLoadingUserDocument])

  const loadSoulDocumentDraft = useCallback(async (): Promise<void> => {
    if (isLoadingSoulDocument) {
      return
    }

    setIsLoadingSoulDocument(true)
    setSoulDocumentError(null)

    try {
      const document = await loadSoulDocument()
      setSavedSoulDocument(document)
      setSoulDocumentDraft(document.evolvedTraits)
    } catch (reason) {
      setSoulDocumentError(reason instanceof Error ? reason.message : 'Failed to load SOUL.md.')
    } finally {
      setIsLoadingSoulDocument(false)
    }
  }, [isLoadingSoulDocument])

  const loadChannelRecords = useCallback(
    async (options?: { force?: boolean }): Promise<void> => {
      if (isLoadingChannelRecords) {
        return
      }

      if (!options?.force && savedChannelUsers && savedChannelGroups) {
        return
      }

      setIsLoadingChannelRecords(true)
      setChannelRecordsError(null)

      try {
        const [users, groups] = await Promise.all([
          window.api.yachiyo.listChannelUsers(),
          window.api.yachiyo.listChannelGroups()
        ])
        setSavedChannelUsers(users)
        setChannelUsersDraft(users)
        setSavedChannelGroups(groups)
        setChannelGroupsDraft(groups)
      } catch (reason) {
        setChannelRecordsError(
          reason instanceof Error ? reason.message : 'Failed to load channel records.'
        )
      } finally {
        setIsLoadingChannelRecords(false)
      }
    },
    [isLoadingChannelRecords, savedChannelGroups, savedChannelUsers]
  )

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
  const isSettingsDirty = JSON.stringify(savedConfig) !== JSON.stringify(draft)
  const isChannelsDirty =
    savedChannelsConfig !== null &&
    channelsDraft !== null &&
    JSON.stringify(savedChannelsConfig) !== JSON.stringify(channelsDraft)
  const isUserDocumentDirty =
    userDocumentDraft !== null &&
    hasPendingUserDocumentChanges(savedUserDocument?.content ?? '', userDocumentDraft)
  const isSoulDocumentDirty =
    soulDocumentDraft !== null &&
    hasPendingSoulDocumentChanges(savedSoulDocument?.evolvedTraits ?? [], soulDocumentDraft)
  const isChannelUsersDirty =
    savedChannelUsers !== null &&
    channelUsersDraft !== null &&
    hasPendingChannelUserChanges(savedChannelUsers, channelUsersDraft)
  const isChannelGroupsDirty =
    savedChannelGroups !== null &&
    channelGroupsDraft !== null &&
    hasPendingChannelGroupChanges(savedChannelGroups, channelGroupsDraft)
  const isDirty =
    isSettingsDirty ||
    isChannelsDirty ||
    isUserDocumentDirty ||
    isSoulDocumentDirty ||
    isChannelUsersDirty ||
    isChannelGroupsDirty
  const hasSaveableChanges =
    (Boolean(draft) && isSettingsDirty && !validationError) ||
    isChannelsDirty ||
    isUserDocumentDirty ||
    isSoulDocumentDirty ||
    isChannelUsersDirty ||
    isChannelGroupsDirty
  const activeValidationError = isSettingsDirty ? validationError : null
  const channelProviders =
    activeValidationError && savedConfig ? savedConfig.providers : (draft?.providers ?? [])

  const handleSave = useCallback(async (): Promise<void> => {
    if (saving) {
      return
    }

    const hasSettingsToSave = Boolean(draft) && isSettingsDirty && !validationError
    const hasChannelsToSave =
      Boolean(channelsDraft) &&
      Boolean(savedChannelsConfig) &&
      !channelsConfigError &&
      isChannelsDirty
    const hasUserDocumentToSave = isUserDocumentDirty
    const hasSoulDocumentToSave = isSoulDocumentDirty
    const hasChannelUsersToSave = isChannelUsersDirty
    const hasChannelGroupsToSave = isChannelGroupsDirty

    if (
      !hasSettingsToSave &&
      !hasChannelsToSave &&
      !hasUserDocumentToSave &&
      !hasSoulDocumentToSave &&
      !hasChannelUsersToSave &&
      !hasChannelGroupsToSave
    ) {
      return
    }

    setSaving(true)
    setError(null)

    try {
      let nextConfig = draft
      if (hasSettingsToSave && draft) {
        nextConfig = await window.api.yachiyo.saveConfig(draft)
        setSavedConfig(nextConfig)
        setDraft(nextConfig)
        setSelectedProviderId((current) =>
          nextConfig!.providers.some((provider) => provider.id === current)
            ? current
            : (nextConfig!.providers[0]?.id ?? '')
        )

        // Sync update channel to the running auto-updater after persisting
        const channel = nextConfig.general?.updateChannel ?? 'stable'
        window.api.appUpdate.setChannel(channel)
      }

      let nextChannels = channelsDraft
      if (hasChannelsToSave && channelsDraft) {
        const persistedProviders = (hasSettingsToSave ? nextConfig : savedConfig)?.providers ?? []
        const sanitizedChannelsDraft = sanitizeChannelsConfig(channelsDraft, persistedProviders)
        nextChannels = await window.api.yachiyo.saveChannelsConfig(sanitizedChannelsDraft)
        setSavedChannelsConfig(nextChannels)
        setChannelsDraft(nextChannels)
      }

      if (hasUserDocumentToSave && userDocumentDraft !== null) {
        const nextUserDocument = await persistUserDocument(userDocumentDraft)
        setSavedUserDocument(nextUserDocument)
        setUserDocumentDraft(nextUserDocument.content)
        setUserDocumentError(null)
      }

      if (hasSoulDocumentToSave && soulDocumentDraft !== null) {
        const nextSoulDocument = await persistSoulDocument(
          savedSoulDocument?.evolvedTraits ?? [],
          soulDocumentDraft
        )
        setSavedSoulDocument(nextSoulDocument)
        setSoulDocumentDraft(nextSoulDocument.evolvedTraits)
        setSoulDocumentError(null)
      }

      if (hasChannelUsersToSave && savedChannelUsers && channelUsersDraft) {
        const nextUsers = await persistChannelUserDrafts(savedChannelUsers, channelUsersDraft)
        setSavedChannelUsers(nextUsers)
        setChannelUsersDraft(nextUsers)
        setChannelRecordsError(null)
      }

      if (hasChannelGroupsToSave && savedChannelGroups && channelGroupsDraft) {
        const nextGroups = await persistChannelGroupDrafts(savedChannelGroups, channelGroupsDraft)
        setSavedChannelGroups(nextGroups)
        setChannelGroupsDraft(nextGroups)
        setChannelRecordsError(null)
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Failed to save settings.')
    } finally {
      setSaving(false)
    }
  }, [
    channelGroupsDraft,
    channelUsersDraft,
    channelsDraft,
    draft,
    isChannelGroupsDirty,
    isChannelUsersDirty,
    isChannelsDirty,
    isSettingsDirty,
    isSoulDocumentDirty,
    isUserDocumentDirty,
    savedChannelGroups,
    savedChannelUsers,
    savedConfig,
    savedSoulDocument,
    saving,
    soulDocumentDraft,
    userDocumentDraft,
    validationError,
    savedChannelsConfig,
    channelsConfigError
  ])
  const handleSaveRef = useRef(handleSave)
  handleSaveRef.current = handleSave

  useEffect(() => {
    const previousActiveTab = previousActiveTabRef.current
    previousActiveTabRef.current = activeTab

    if (activeTab !== 'channels' || previousActiveTab === 'channels') {
      return
    }

    if (isChannelUsersDirty || isChannelGroupsDirty) {
      return
    }

    void loadChannelRecords({ force: true })
  }, [activeTab, isChannelGroupsDirty, isChannelUsersDirty, loadChannelRecords])

  const triggerSave = useCallback(async (): Promise<void> => {
    const activeElement = document.activeElement
    if (activeElement instanceof HTMLElement) {
      activeElement.blur()
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()))
    }

    await handleSaveRef.current()
  }, [])

  // Global keyboard shortcut: Cmd/Ctrl+S to save
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        if (e.defaultPrevented) return
        e.preventDefault()
        void triggerSave()
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [triggerSave])

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
      body = (
        <GeneralPane
          draft={draft}
          onChange={setDraft}
          userDocument={savedUserDocument}
          userDraft={userDocumentDraft}
          isLoadingUserDocument={isLoadingUserDocument}
          userDocumentError={userDocumentError}
          onLoadUserDocument={loadUserDocumentDraft}
          onUserDraftChange={setUserDocumentDraft}
          onRevertUserDocument={() => {
            setUserDocumentDraft(savedUserDocument?.content ?? '')
            setUserDocumentError(null)
          }}
          soulDocument={savedSoulDocument}
          soulDraftTraits={soulDocumentDraft}
          isLoadingSoulDocument={isLoadingSoulDocument}
          soulDocumentError={soulDocumentError}
          onLoadSoulDocument={loadSoulDocumentDraft}
          onSoulDraftChange={setSoulDocumentDraft}
          onRevertSoulDocument={() => {
            setSoulDocumentDraft(savedSoulDocument?.evolvedTraits ?? [])
            setSoulDocumentError(null)
          }}
        />
      )
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
      if (isLoadingChannelsConfig) {
        body = (
          <div className="flex-1 overflow-y-auto flex items-center justify-center">
            <span className="text-sm" style={{ color: theme.text.muted }}>
              Loading channels settings...
            </span>
          </div>
        )
      } else if (channelsConfigError || !channelsDraft) {
        body = (
          <div className="flex-1 overflow-y-auto px-7 py-6">
            <div className="text-sm" style={{ color: theme.text.dangerStrong }}>
              {channelsConfigError ?? 'Channels settings are unavailable.'}
            </div>
            <div className="mt-2 text-sm" style={{ color: theme.text.tertiary }}>
              Fix `channels.toml` or reload the settings window before editing channel settings.
            </div>
          </div>
        )
      } else {
        body = (
          <ChannelsPane
            activeSubTab={activeSubTab['channels'] ?? 'general'}
            config={channelsDraft}
            onConfigChange={setChannelsDraft}
            users={channelUsersDraft}
            groups={channelGroupsDraft}
            isLoadingRecords={isLoadingChannelRecords}
            channelRecordsError={channelRecordsError}
            onUsersChange={setChannelUsersDraft}
            onGroupsChange={setChannelGroupsDraft}
            providers={channelProviders}
          />
        )
      }
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

  if (activeTab === 'usage') {
    body = <UsagePane />
  }

  if (activeTab === 'about') {
    body = draft ? <AboutPane draft={draft} onChange={setDraft} /> : body
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
              color: error || activeValidationError ? theme.text.dangerStrong : theme.text.muted,
              visibility: isDirty || saving || error || activeValidationError ? 'visible' : 'hidden'
            }}
          >
            {error
              ? error
              : activeValidationError
                ? activeValidationError
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
              onClick={() => void triggerSave()}
              disabled={!hasSaveableChanges || saving || loading}
              className="px-4 py-1.5 rounded-lg text-sm font-medium transition-all"
              style={{
                minHeight: 36,
                border: '1px solid transparent',
                ...(!hasSaveableChanges || saving || loading
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
