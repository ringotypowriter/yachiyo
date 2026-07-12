export const threads = {
  list: {
    noMatchFilter: 'No threads match the current filter.',
    clearFilters: 'Clear filters',
    noArchived: 'No archived threads yet.',
    noChats: 'No chats yet. Start one from the compose box or the new chat button.',
    starred: 'Starred',
    selectThreads: 'Select threads',
    selectedCount: '{count} selected',
    regenerateTitles: 'Regenerate titles',
    createFolderFromSelected: 'Create folder from selected',
    archiveSelected: 'Archive selected',
    restoreSelected: 'Restore selected',
    deleteSelected: 'Delete selected',
    exitSelectMode: 'Exit select mode',
    attachmentCount: { one: '{count} attachment', other: '{count} attachments' }
  },
  item: {
    clickToChangeIcon: 'Click to change icon',
    readOnlySynced: 'Read-only — synced from another device',
    sentinelActive: 'Sentinel active',
    sentinelArmed: 'Sentinel armed',
    sentinelIn: { one: 'Sentinel in {count} minute', other: 'Sentinel in {count} minutes' },
    runActive: 'Run active',
    unread: 'Unread'
  },
  preview: {
    pendingApproval: 'Pending approval',
    noMessagesYet: 'No messages yet',
    draftTag: '[Draft]',
    planTag: '[Plan]'
  },
  contextMenu: {
    select: 'Select',
    continueChat: 'Continue Chat',
    star: 'Star',
    unstar: 'Unstar',
    regenerateTitle: 'Regenerate Title',
    handoff: 'Handoff',
    createFolder: 'Create Folder',
    removeFromFolder: 'Remove from Folder',
    markItDefault: 'Mark it Default'
  },
  folder: {
    archiveAll: 'Archive All',
    restoreAll: 'Restore All',
    discardFolder: 'Discard Folder'
  },
  colors: {
    title: 'Color',
    markIt: 'Mark it {color}',
    coral: 'Coral',
    azure: 'Azure',
    emerald: 'Emerald',
    amethyst: 'Amethyst',
    slate: 'Slate'
  },
  filter: {
    all: 'All',
    running: 'Running',
    justDone: 'Just Done',
    folderOnly: 'Folder-Only',
    folders: 'Folders',
    filtersCount: '{count} filters',
    filterChats: 'Filter chats',
    filterChatsWith: 'Filter chats: {label}',
    resetFilters: 'Reset filters',
    status: 'Status',
    workspace: 'Workspace',
    temporary: 'Temporary',
    unreadCount: '{count} unread'
  },
  actions: {
    archive: 'Archive',
    restore: 'Restore',
    saveMemoryAndArchive: 'Save Memory & Archive'
  },
  confirm: {
    archiveTitle: 'Archive "{title}"?',
    archiveManyTitle: { one: 'Archive {count} thread?', other: 'Archive {count} threads?' },
    restoreManyTitle: { one: 'Restore {count} thread?', other: 'Restore {count} threads?' },
    deleteManyTitle: {
      one: 'Delete {count} thread permanently?',
      other: 'Delete {count} threads permanently?'
    },
    archiveFolderTitle: {
      one: 'Archive all {count} thread in "{title}"?',
      other: 'Archive all {count} threads in "{title}"?'
    },
    restoreFolderTitle: {
      one: 'Restore all {count} thread in "{title}"?',
      other: 'Restore all {count} threads in "{title}"?'
    },
    deleteTitle: 'Delete "{title}" permanently?',
    activeRunTitle: '"{title}" has an active run.',
    activeRunMessage: 'Cancel the run and delete this thread?'
  },
  errors: {
    rename: 'Failed to rename the thread.',
    archive: 'Failed to archive the thread.',
    archiveMany: 'Failed to archive threads.',
    archiveFolder: 'Failed to archive folder threads.',
    restore: 'Failed to restore the thread.',
    restoreMany: 'Failed to restore threads.',
    restoreFolder: 'Failed to restore folder threads.',
    delete: 'Failed to delete the thread.',
    deleteMany: 'Failed to delete threads.',
    update: 'Failed to update the thread.',
    updateIcon: 'Failed to update the thread icon.',
    updateColor: 'Failed to update the thread color.',
    regenerateTitles: 'Failed to regenerate thread titles.',
    compact: 'Failed to compact into another thread.'
  }
} as const
