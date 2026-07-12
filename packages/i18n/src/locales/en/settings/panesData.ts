export const memory = {
  title: 'Memory',
  termsTitle: 'Memory terms',
  termsDescription:
    'Cognitive memory as a compact indexed list. Each row keeps the topic, type, content, and update metadata visible.',
  termCount: { one: '{count} term', other: '{count} terms' },
  topicCount: { one: '{count} topic', other: '{count} topics' },
  termsAcrossTopics: '{terms} across {topics}',
  loadingTerms: 'Loading memory terms...',
  loadTermsFailed: 'Failed to load memory terms.',
  forgetTermFailed: 'Failed to forget memory term.',
  termsInTopic: { one: '{count} term in topic', other: '{count} terms in topic' },
  importanceLabel: 'importance {value}',
  activatedCount: 'activated {count}',
  updatedLabel: 'updated',
  lastUsedLabel: 'last used',
  forget: 'Forget',
  forgetting: 'Forgetting...',
  noTerms: 'No memory terms yet.',
  termUnit: { one: 'term', other: 'terms' },
  forgetConfirmTitle: 'Forget "{title}" permanently?',
  forgetConfirmMessage:
    'This deletes the memory row from local cognitive memory. It cannot be undone.',
  enableTitle: 'Enable memory',
  enableDescription: 'Pull recalled context into runs and allow explicit thread saves.',
  toggleMemoryAria: 'Toggle memory',
  termsRowDescription: 'View the memory hierarchy grouped by stored topic.',
  viewTerms: 'View terms',
  autoDistillTitle: 'Auto-distill memory after runs',
  autoDistillDescription: 'When off, memory is updated only when you use the remember tool.',
  toggleAutoDistillAria: 'Toggle auto memory distillation',
  autoRecallTitle: 'Auto Recall',
  autoRecallDescription: 'When off, new runs start without pulling in saved memories.',
  toggleAutoRecallAria: 'Toggle automatic memory recall',
  toolModelNote:
    'Auto-recall and post-run distillation use the tool model configured in Chat settings.'
} as const

export const workspace = {
  savedFolders: 'Saved Folders',
  noSavedFolders:
    'No saved folders yet. When you pick a specific workspace from Composer, it will show up here.',
  removeFolderAria: 'Remove {path}',
  labelPlaceholder: 'Add label for agent context...',
  selectDirectory: 'Select directory...',
  openWith: 'Open With',
  editor: 'Editor',
  terminal: 'Terminal',
  markdownDocument: 'Markdown document',
  selectEditorPlaceholder: 'Select an editor…',
  selectTerminalPlaceholder: 'Select a terminal…',
  selectMarkdownEditorPlaceholder: 'Select a markdown editor…',
  maintenance: 'Maintenance',
  pruneButton: 'Prune empty temporary workspaces',
  pruneConfirmTitle: 'Delete empty temporary workspaces?',
  pruneConfirmMessage: 'This cannot be undone.',
  prunedResult: {
    one: 'Pruned {count} empty temporary workspace.',
    other: 'Pruned {count} empty temporary workspaces.'
  },
  pruneFailed: 'Failed to prune temporary workspaces',
  noAppsFound: 'No apps found on your system'
} as const

export const skills = {
  searchPlaceholder: 'Search skills',
  openFolderTitle: 'Open skills folder',
  openFolder: 'Open Folder',
  noSkills: 'No Skills are currently discoverable from global sources.',
  noMatches: 'No skills match “{query}”.',
  defaultDescription: 'Available to activate for runs that can see this skill.',
  toggleSkillAria: 'Toggle {name} skill'
} as const

export const search = {
  searchProvider: 'Search Provider',
  apiKey: 'API Key',
  apiKeyPlaceholder: 'your-exa-api-key',
  showApiKey: 'Show API key',
  hideApiKey: 'Hide API key',
  browserSession: 'Browser Session',
  browserSessionDescription:
    'Hidden browser search keeps its own session. Import from Chrome to bootstrap cookies and consent state.',
  chromeProfile: 'Chrome profile',
  noChromeProfiles: 'No Chrome profiles found',
  lastImport: 'Last import: {browser} / {profile}',
  noSessionImported: 'No session imported yet.',
  importFromChrome: 'Import from Chrome',
  loadSourcesFailed: 'Failed to load browser import sources.',
  importFailed: 'Failed to import Chrome session.'
} as const

export const sync = {
  title: 'Sync',
  fileSync: 'File Sync',
  description:
    'Settings and remote chat archives sync through a local folder. Use the recommended iCloud Drive folder, or choose another folder you manage yourself. Synced chats from other devices stay read-only.',
  syncing: 'Syncing...',
  loadingStatus: 'Loading sync status...',
  statusUnavailable: 'Sync folder unavailable',
  statusNotEnabledDevice: 'Not enabled on this device',
  statusNotInitialized: 'Not initialized',
  statusNeedsAttention: 'Needs attention',
  statusReady: 'Ready',
  joinThisDevice: 'Join This Device',
  enableSync: 'Enable Sync',
  syncNow: 'Sync Now',
  resolvingFolder: 'Resolving sync folder...',
  useICloudFolder: 'Use iCloud Folder',
  chooseFolder: 'Choose Folder',
  deviceCount: { one: '{count} device', other: '{count} devices' },
  pendingConflicts: { one: '{count} pending conflict', other: '{count} pending conflicts' },
  deviceIdLabel: 'Device {id}',
  unavailableHint:
    'Choose an existing folder, or sign in to iCloud Drive and enable Documents sync in macOS before using the recommended folder.',
  joinableHint: 'Sync is already active on another device. Join to pull your synced chats here.',
  conflicts: 'Conflicts',
  refresh: 'Refresh',
  noConflicts: 'No pending sync conflicts.',
  fromDevice: 'From device {id} · {createdAt}',
  fieldsDiffer: { one: '{count} field differs', other: '{count} fields differ' },
  allThisDevice: 'All: this device',
  allSynced: 'All: synced',
  thisDevice: 'This device',
  synced: 'Synced',
  apply: 'Apply',
  copySyncedToml: 'Copy Synced TOML',
  localHash: 'Local: {hash}',
  syncedHash: 'Synced: {hash}',
  keepThisDevice: 'Keep This Device',
  useSyncedVersion: 'Use Synced Version',
  useSyncedConfirmTitle: 'Use synced settings?',
  useSyncedConfirmMessage: 'This replaces this device’s current settings with the synced version.',
  loadStatusFailed: 'Failed to load sync status.',
  initFailed: 'Failed to initialize sync.',
  syncNowFailed: 'Failed to sync now.',
  updateFolderFailed: 'Failed to update sync folder.',
  resolveConflictFailed: 'Failed to resolve conflict.'
} as const
