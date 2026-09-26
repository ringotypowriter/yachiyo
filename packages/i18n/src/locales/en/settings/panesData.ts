export const memory = {
  title: 'Memory',
  termsTitle: 'Saved memories',
  termsDescription: 'Notes Yachiyo keeps from past conversations, grouped by topic.',
  termCount: { one: '{count} memory', other: '{count} memories' },
  topicCount: { one: '{count} topic', other: '{count} topics' },
  termsAcrossTopics: '{terms} across {topics}',
  loadingTerms: 'Loading memories...',
  loadTermsFailed: 'Failed to load memories.',
  forgetTermFailed: 'Failed to forget memory.',
  termsInTopic: { one: '{count} in this topic', other: '{count} in this topic' },
  importanceLabel: 'importance {value}',
  activatedCount: 'used {count}×',
  updatedLabel: 'updated',
  lastUsedLabel: 'last used',
  forget: 'Forget',
  forgetting: 'Forgetting...',
  noTerms: 'No saved memories yet.',
  termUnit: { one: 'memory', other: 'memories' },
  forgetConfirmTitle: 'Forget "{title}" permanently?',
  forgetConfirmMessage:
    'This permanently deletes the memory. The conversation it came from stays untouched.',
  enableTitle: 'Enable memory',
  enableDescription: 'Bring relevant memories into replies and allow saving threads to memory.',
  toggleMemoryAria: 'Toggle memory',
  termsRowDescription: 'Browse and forget memories, grouped by topic.',
  viewTerms: 'View memories',
  autoDistillTitle: 'Save memories automatically',
  autoDistillDescription: 'When off, memories are saved only when you ask Yachiyo to remember.',
  toggleAutoDistillAria: 'Toggle automatic memory saving',
  autoRecallTitle: 'Use memories automatically',
  autoRecallDescription: 'When off, replies start without bringing in saved memories.',
  toggleAutoRecallAria: 'Toggle automatic memory use',
  toolModelNote: 'Automatic memory saving and use run on the tool model set in Chat settings.'
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
  pruneButton: 'Prune',
  pruneLabel: 'Empty temporary workspaces',
  pruneDesc: 'Temporary workspaces left behind by runs that never wrote a file.',
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
    'Settings, custom skills, and remote chat archives sync through a local folder. Custom skills sync as a full tree, including script contents. Use the recommended iCloud Drive folder, or choose another folder you manage yourself. Synced chats from other devices stay read-only.',
  descriptionWindows:
    'Settings, custom skills, and remote chat archives sync through a local folder. Custom skills sync as a full tree, including script contents. Use the recommended OneDrive folder, or choose another synced folder you manage yourself. Synced chats from other devices stay read-only.',
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
  useOneDriveFolder: 'Use OneDrive Folder',
  chooseFolder: 'Choose Folder',
  deviceCount: { one: '{count} device', other: '{count} devices' },
  pendingConflicts: { one: '{count} pending conflict', other: '{count} pending conflicts' },
  deviceIdLabel: 'Device {id}',
  unavailableHint:
    'Choose an existing folder, or sign in to iCloud Drive and enable Documents sync in macOS before using the recommended folder.',
  unavailableHintWindows:
    'Choose an existing folder, or sign in to OneDrive before using the recommended folder.',
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
  copySyncedToml: 'Copy Synced Data',
  localHash: 'Local: {hash}',
  syncedHash: 'Synced: {hash}',
  keepThisDevice: 'Keep This Device',
  useSyncedVersion: 'Use Synced Version',
  useSyncedConfirmTitle: 'Use synced version?',
  useSyncedConfirmMessage: 'This replaces the current local version with the synced version.',
  loadStatusFailed: 'Failed to load sync status.',
  initFailed: 'Failed to initialize sync.',
  syncNowFailed: 'Failed to sync now.',
  updateFolderFailed: 'Failed to update sync folder.',
  resolveConflictFailed: 'Failed to resolve conflict.'
} as const
