export const layout = {
  tabs: {
    work: 'Work',
    things: 'Things',
    archived: 'Archived',
    settings: 'Settings'
  },
  tabBar: {
    appSections: 'App sections',
    versionAvailable: 'v{version} available',
    updateAvailable: 'Update available',
    installUpdate: 'Install update',
    update: 'Update',
    more: 'More',
    moreOptions: 'More options'
  },
  sidebar: {
    threadCount: { one: '{count} thread', other: '{count} threads' },
    searchArchivedChats: 'Search archived chats',
    markAllAsRead: 'Mark all as read',
    searchChats: 'Search chats',
    newChat: 'New chat'
  },
  utilityMenu: {
    serverReady: 'Server ready',
    serverOffline: 'Server offline',
    externalThreads: 'External threads',
    onBadge: 'ON',
    translator: 'Translator',
    jotDown: 'Jot Down'
  },
  header: {
    loadingWorkspace: 'Loading local workspace...',
    messageCount: { one: '{count} message', other: '{count} messages' },
    noMessagesYet: 'No messages yet',
    startConversation: 'Start a conversation',
    threadOptions: 'Thread options',
    openWorkspaceInFinder: 'Open workspace in Finder',
    openWorkspaceInTerminal: 'Open workspace in terminal',
    openWorkspaceInEditor: 'Open workspace in editor',
    openRunInspector: 'Open run inspector',
    closeRunInspector: 'Close run inspector',
    privacy: {
      lockedOn: 'Privacy Mode: Locked (On)',
      lockedOff: 'Privacy Mode: Locked (Off)',
      on: 'Privacy Mode: On',
      off: 'Privacy Mode: Off',
      descLockedOn:
        'Memory recall and distillation are disabled — cannot change after messages are sent',
      descLockedOff: 'Cannot change after messages are sent',
      descOn: 'Memory recall and distillation are disabled',
      descOff: 'Enable to hide this thread from memory'
    }
  },
  welcome: {
    greeting1: 'Where shall we begin?',
    greeting2: 'What are we making today?',
    greeting3: 'Bring me the messy part.',
    greeting4: 'Ready when you are.',
    slogan1: 'Start rough. We can make it sharper.',
    slogan2: 'Drop in a thought, a file, or a half-shaped plan.',
    slogan3: 'Paste the tangle here — Yachiyo will carry it from there.',
    slogan4: 'A small prompt is enough to begin.',
    creationWith: 'Creation with',
    essentialFallback: 'Essential',
    essentialSlogan: 'Send a first message to start a focused thread with this Essential.',
    savingToMemory: 'Saving to memory…',
    interactionsPaused: 'Thread interactions are paused'
  },
  sparks: {
    pulse: { label: 'Pulse', hint: "Catch up on yesterday's work" },
    sisyphus: { label: 'Sisyphus', hint: 'Spot the work that keeps rolling back' },
    grill: { label: 'Grill', hint: 'Grill a vague idea into a real plan' },
    mirror: { label: 'Mirror', hint: 'Audit what Yachiyo believes about you' },
    constellation: { label: 'Constellation', hint: 'Find hidden links across your work' },
    brainstorm: { label: 'Brainstorm', hint: 'Storm ideas from a topic and what you already have' }
  },
  archived: {
    title: 'Archived',
    heading: 'Archived threads',
    selectPrompt: 'Select an archived thread from the sidebar to view it.',
    noMessages: 'No messages',
    continueChat: 'Continue chat',
    deletePermanently: 'Delete permanently',
    scheduleResult: 'Schedule result',
    startedAt: 'Started {time}',
    finishedAt: 'Finished {time}',
    tokens: '{tokens} tokens'
  },
  dialogs: {
    renameThreadTitle: 'Rename thread'
  },
  browserActivity: {
    responding: 'Responding',
    latestResponse: 'Latest response',
    browserStep: 'Browser step',
    stepInSession: '{action} in {session}'
  },
  errors: {
    togglePrivacy: 'Failed to toggle privacy mode.',
    openWorkspace: 'Failed to open the workspace.',
    openEditor: 'Failed to open in editor.',
    openTerminal: 'Failed to open in terminal.',
    startChat: 'Failed to start the chat.',
    saveSidebarVisibility: 'Failed to save sidebar visibility.'
  }
} as const
