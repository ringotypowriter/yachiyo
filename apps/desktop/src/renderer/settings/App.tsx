import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  BarChart3,
  Clock,
  Compass,
  Cpu,
  Info,
  MessageSquare,
  Radio,
  Sparkles,
  Settings2
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { alpha, theme } from '@renderer/theme/theme'
import { useAppDialog } from '@renderer/components/AppDialogContext'
import { useApplyThemeConfig } from '@renderer/theme/useThemeConfig'
import type {
  ChannelGroupRecord,
  ChannelUserRecord,
  ChannelsConfig,
  SettingsConfig,
  SkillCatalogEntry,
  SoulDocument,
  UserDocument
} from '@yachiyo/shared/protocol'
import { getToolModelConfig, resolveToolModelProvider } from '@yachiyo/shared/providerConfig'
import { PlaceholderPane } from './components/primitives'
import { ChatPane } from './panes/ChatPane'
import { BehaviorPane } from './panes/BehaviorPane'
import { MemoryPane } from './panes/MemoryPane'
import { ProvidersPane } from './panes/ProvidersPane'
import { SearchPane } from './panes/SearchPane'
import { PromptsPane } from './panes/PromptsPane'
import { CodingAgentsPane } from './panes/CodingAgentsPane'
import { SkillsPane } from './panes/SkillsPane'
import { UIPane } from './panes/UIPane'
import { WorkspacePane } from './panes/WorkspacePane'
import { AboutPane } from './panes/AboutPane'
import { ActivityPane } from './panes/ActivityPane'
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
  persistSoulDocument,
  toSoulTraitTexts
} from './panes/soulDocumentEditorModel'
import {
  hasPendingUserDocumentChanges,
  loadUserDocument,
  persistUserDocument
} from './panes/userDocumentEditorModel'
import {
  SETTINGS_PANELS,
  getInitialSettingsPanelTabs,
  resolveSettingsRoute,
  serializeSettingsRoute,
  type SettingsPanelDefinition,
  type SettingsPanelId
} from './settingsNavigation'

interface AppPanel extends SettingsPanelDefinition {
  icon: LucideIcon
}

const PANEL_ICONS: Record<SettingsPanelId, LucideIcon> = {
  general: Settings2,
  providers: Cpu,
  chat: MessageSquare,
  capabilities: Sparkles,
  source: Compass,
  channels: Radio,
  schedules: Clock,
  usage: BarChart3,
  about: Info
}

const PANELS: AppPanel[] = SETTINGS_PANELS.map((panel) => ({
  ...panel,
  icon: PANEL_ICONS[panel.id]
}))

function getInitialActivePanelTabs(routeValue: string): Record<string, string> {
  const panelTabs = getInitialSettingsPanelTabs()
  const route = resolveSettingsRoute(routeValue)
  if (route.tab) {
    panelTabs[route.panel] = route.tab
  }
  return panelTabs
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

export interface SettingsPanelProps {
  active: boolean
  children: (slots: SettingsPanelSlots) => React.JSX.Element
  route: string
  onActivateChat: () => void
  onRouteChange: (route: string) => void
}

export interface SettingsPanelSlots {
  content: ReactNode
  contentSubControls?: ReactNode
  contentTopControls: ReactNode
}

export interface SettingsSidebarControlsProps {
  route: string
  onRouteChange: (route: string) => void
}

export function SettingsSidebarContent({
  route,
  onRouteChange
}: SettingsSidebarControlsProps): React.JSX.Element {
  const activePanel = resolveSettingsRoute(route).panel

  return (
    <nav className="no-drag flex-1 overflow-y-auto px-2 pb-3 pt-2" aria-label="Settings sections">
      {PANELS.map(({ id, label, icon: Icon }) => {
        const isActive = activePanel === id
        return (
          <button
            key={id}
            onClick={() => onRouteChange(id)}
            className="mb-1 flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-sm transition-all"
            style={
              isActive
                ? {
                    background: theme.background.counterSurface,
                    color: theme.text.counter,
                    fontWeight: 600,
                    boxShadow: theme.shadow.button
                  }
                : {
                    background: 'transparent',
                    color: theme.text.secondary
                  }
            }
          >
            <Icon
              size={16}
              strokeWidth={1.7}
              style={{ opacity: isActive ? 1 : 0.58, flexShrink: 0 }}
            />
            <span className="truncate">{label}</span>
          </button>
        )
      })}
    </nav>
  )
}

function SettingsPanel({
  active,
  children,
  route,
  onActivateChat,
  onRouteChange
}: SettingsPanelProps): React.JSX.Element {
  const [activePanel, setActivePanel] = useState<SettingsPanelId>(
    () => resolveSettingsRoute(route).panel
  )
  const [activePanelTabs, setActivePanelTabs] = useState(() => getInitialActivePanelTabs(route))
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
  const previousActivePanelRef = useRef<SettingsPanelId | null>(null)
  const dialog = useAppDialog()
  useApplyThemeConfig(active ? (draft ?? savedConfig) : savedConfig, false)

  useEffect(() => {
    const nextRoute = resolveSettingsRoute(route)
    setActivePanel(nextRoute.panel)
    if (nextRoute.tab) {
      setActivePanelTabs((current) => ({ ...current, [nextRoute.panel]: nextRoute.tab! }))
    }
  }, [route])

  const navigateToRoute = useCallback(
    (routeValue: string): void => {
      const nextRoute = resolveSettingsRoute(routeValue)
      setActivePanel(nextRoute.panel)
      setActivePanelTabs((current) => {
        const nextPanelTab = nextRoute.tab ?? current[nextRoute.panel]
        return nextPanelTab ? { ...current, [nextRoute.panel]: nextPanelTab } : current
      })
      onRouteChange(
        serializeSettingsRoute(nextRoute.panel, nextRoute.tab ?? activePanelTabs[nextRoute.panel])
      )
    },
    [activePanelTabs, onRouteChange]
  )

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
      setSoulDocumentDraft(toSoulTraitTexts(document.evolvedTraits))
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
      .listSkills({ workspacePaths: [] })
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

  const activeSettingsPanel = PANELS.find((panel) => panel.id === activePanel) ?? PANELS[0]
  const activePanelTab =
    activeSettingsPanel.tabs?.find((tab) => tab.id === activePanelTabs[activeSettingsPanel.id]) ??
    activeSettingsPanel.tabs?.[0]
  const activePanelTabId = activePanelTab?.id
  const validationError = validateConfig(draft)
  const isSettingsDirty = JSON.stringify(savedConfig) !== JSON.stringify(draft)
  const isChannelsDirty =
    savedChannelsConfig !== null &&
    channelsDraft !== null &&
    JSON.stringify(savedChannelsConfig) !== JSON.stringify(channelsDraft)
  const isUserDocumentDirty =
    userDocumentDraft !== null &&
    hasPendingUserDocumentChanges(savedUserDocument?.content ?? '', userDocumentDraft)
  const savedSoulTraits = useMemo(
    () => toSoulTraitTexts(savedSoulDocument?.evolvedTraits),
    [savedSoulDocument?.evolvedTraits]
  )
  const isSoulDocumentDirty =
    soulDocumentDraft !== null && hasPendingSoulDocumentChanges(savedSoulTraits, soulDocumentDraft)
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
        const nextSoulDocument = await persistSoulDocument(savedSoulTraits, soulDocumentDraft)
        setSavedSoulDocument(nextSoulDocument)
        setSoulDocumentDraft(toSoulTraitTexts(nextSoulDocument.evolvedTraits))
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
    savedSoulTraits,
    saving,
    soulDocumentDraft,
    userDocumentDraft,
    validationError,
    savedChannelsConfig,
    channelsConfigError
  ])
  const handleSaveRef = useRef(handleSave)
  handleSaveRef.current = handleSave

  const handleDiscardChanges = useCallback(async (): Promise<void> => {
    if (!isDirty || saving) {
      return
    }

    const confirmed = await dialog.confirm({
      title: 'Discard unsaved changes?',
      message: 'This resets every unsaved settings draft to the last saved version.',
      confirmLabel: 'Discard',
      cancelLabel: 'Cancel',
      tone: 'danger'
    })
    if (!confirmed) {
      return
    }

    setDraft(savedConfig)
    setChannelsDraft(savedChannelsConfig)
    if (userDocumentDraft !== null) {
      setUserDocumentDraft(savedUserDocument?.content ?? '')
      setUserDocumentError(null)
    }
    if (soulDocumentDraft !== null) {
      setSoulDocumentDraft(savedSoulTraits)
      setSoulDocumentError(null)
    }
    setChannelUsersDraft(savedChannelUsers)
    setChannelGroupsDraft(savedChannelGroups)
    setSelectedProviderId((current) =>
      savedConfig?.providers.some((provider) => provider.id === current)
        ? current
        : (savedConfig?.providers[0]?.id ?? '')
    )
    setError(null)
  }, [
    dialog,
    isDirty,
    savedChannelGroups,
    savedChannelUsers,
    savedChannelsConfig,
    savedConfig,
    savedSoulTraits,
    savedUserDocument?.content,
    saving,
    soulDocumentDraft,
    userDocumentDraft
  ])

  useEffect(() => {
    const previousActivePanel = previousActivePanelRef.current
    previousActivePanelRef.current = activePanel

    if (activePanel !== 'channels' || previousActivePanel === 'channels') {
      return
    }

    if (isChannelUsersDirty || isChannelGroupsDirty) {
      return
    }

    void loadChannelRecords({ force: true })
  }, [activePanel, isChannelGroupsDirty, isChannelUsersDirty, loadChannelRecords])

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
    if (!active) {
      return
    }

    const handler = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        if (e.defaultPrevented) return
        e.preventDefault()
        void triggerSave()
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [active, triggerSave])

  let body: React.ReactNode = (
    <PlaceholderPane
      label={activePanelTab ? `${activeSettingsPanel.label} -> ${activePanelTab.label}` : undefined}
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
    if (activePanel === 'general') {
      if ((activePanelTabs.general ?? 'behavior') === 'ui') {
        body = <UIPane draft={draft} onChange={setDraft} />
      } else {
        body = (
          <BehaviorPane
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
              setSoulDocumentDraft(savedSoulTraits)
              setSoulDocumentError(null)
            }}
            onActivateChat={onActivateChat}
            onNavigateToRoute={navigateToRoute}
          />
        )
      }
    } else if (activePanel === 'providers') {
      body = (
        <ProvidersPane
          draft={draft}
          selectedProviderId={selectedProviderId}
          onSelectProvider={setSelectedProviderId}
          onChange={setDraft}
        />
      )
    } else if (activePanel === 'chat') {
      body =
        (activePanelTabs.chat ?? 'threads') === 'essentials' ? (
          <EssentialsPane draft={draft} onChange={setDraft} />
        ) : (
          <ChatPane draft={draft} onChange={setDraft} />
        )
    } else if (activePanel === 'capabilities') {
      const tab = activePanelTabs.capabilities ?? 'skills'
      if (tab === 'coding-agents') {
        body = <CodingAgentsPane draft={draft} onChange={setDraft} />
      } else if (tab === 'prompts') {
        body = <PromptsPane draft={draft} onChange={setDraft} />
      } else if (tab === 'workspace') {
        body = <WorkspacePane draft={draft} onChange={setDraft} />
      } else {
        body = <SkillsPane availableSkills={availableSkills} draft={draft} onChange={setDraft} />
      }
    } else if (activePanel === 'source') {
      const tab = activePanelTabs.source ?? 'memory'
      if (tab === 'activity') {
        body = <ActivityPane draft={draft} onChange={setDraft} />
      } else if (tab === 'search') {
        body = <SearchPane draft={draft} onChange={setDraft} />
      } else {
        body = <MemoryPane draft={draft} onChange={setDraft} />
      }
    } else if (activePanel === 'channels') {
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
              Fix `channels.toml` or reload settings before editing channel settings.
            </div>
          </div>
        )
      } else {
        body = (
          <ChannelsPane
            activeTab={activePanelTabs.channels ?? 'general'}
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
    } else if (activePanel === 'schedules') {
      body = (
        <SchedulePane
          activeTab={activePanelTabs.schedules ?? 'list'}
          onNavigateToRoute={navigateToRoute}
        />
      )
    }
  }

  if (activePanel === 'usage') {
    body = <UsagePane activeTab={activePanelTabs.usage ?? 'usage'} />
  }

  if (activePanel === 'about') {
    body = draft ? <AboutPane draft={draft} onChange={setDraft} /> : body
  }

  const statusText = error
    ? error
    : activeValidationError
      ? activeValidationError
      : saving
        ? 'Saving...'
        : isDirty
          ? 'Unsaved changes'
          : 'All changes saved'
  const statusColor = error || activeValidationError ? theme.text.dangerStrong : theme.text.muted

  return children({
    content: body,
    contentSubControls: activeSettingsPanel.tabs ? (
      <div className="no-drag flex min-w-0 items-center gap-1 overflow-x-auto px-4 py-2">
        {activeSettingsPanel.tabs.map((tab) => {
          const isActive = activePanelTabId === tab.id
          return (
            <button
              key={tab.id}
              onClick={() =>
                navigateToRoute(serializeSettingsRoute(activeSettingsPanel.id, tab.id))
              }
              className="rounded-full px-3 py-1.5 text-sm font-medium transition-colors"
              style={{
                color: isActive ? theme.text.primary : theme.text.muted,
                background: isActive ? alpha('ink', 0.06) : 'transparent'
              }}
            >
              {tab.label}
            </button>
          )
        })}
      </div>
    ) : undefined,
    contentTopControls: (
      <div className="flex min-w-0 flex-1 items-center gap-4 px-5">
        <div className="min-w-0 flex-1">
          <div
            className="truncate text-sm font-semibold"
            style={{ color: theme.text.primary, letterSpacing: '-0.2px' }}
          >
            Settings
          </div>
        </div>

        <div className="no-drag flex shrink-0 items-center gap-2">
          <span className="max-w-[320px] truncate text-xs" style={{ color: statusColor }}>
            {statusText}
          </span>
          <button
            onClick={() => void handleDiscardChanges()}
            disabled={!isDirty || saving || loading}
            className="rounded-full px-3.5 py-1.5 text-sm font-medium transition-all"
            style={{
              minHeight: 34,
              border: '1px solid transparent',
              ...(!isDirty || saving || loading
                ? {
                    background: alpha('ink', 0.02),
                    color: theme.text.muted,
                    opacity: 0.45
                  }
                : {
                    background: theme.background.surface,
                    color: theme.text.secondary
                  })
            }}
          >
            Discard
          </button>
          <button
            onClick={() => void triggerSave()}
            disabled={!hasSaveableChanges || saving || loading}
            className="rounded-full px-4 py-1.5 text-sm font-medium transition-all"
            style={{
              minHeight: 34,
              border: '1px solid transparent',
              ...(!hasSaveableChanges || saving || loading
                ? {
                    background: alpha('ink', 0.04),
                    color: theme.text.muted,
                    opacity: 0.45
                  }
                : {
                    background: theme.text.accent,
                    color: theme.text.inverse,
                    boxShadow: theme.shadow.button
                  })
            }}
          >
            Save
          </button>
        </div>
      </div>
    )
  })
}

export default SettingsPanel
