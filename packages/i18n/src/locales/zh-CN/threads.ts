export const threads = {
  list: {
    noMatchFilter: '没有符合当前筛选的会话。',
    clearFilters: '清除筛选',
    noArchived: '还没有归档会话。',
    noChats: '还没有会话。从输入框或新会话按钮开始一个吧。',
    starred: '星标',
    selectThreads: '选择会话',
    selectedCount: '已选 {count} 个',
    regenerateTitles: '重新生成标题',
    createFolderFromSelected: '为所选会话创建文件夹',
    archiveSelected: '归档所选',
    restoreSelected: '恢复所选',
    deleteSelected: '删除所选',
    exitSelectMode: '退出选择模式',
    attachmentCount: { other: '{count} 个附件' }
  },
  item: {
    clickToChangeIcon: '点击更换图标',
    readOnlySynced: '只读 — 从其他设备同步',
    sentinelActive: '哨兵已激活',
    sentinelArmed: '哨兵已就绪',
    sentinelIn: { other: '{count} 分钟后触发哨兵' },
    runActive: '运行中',
    unread: '未读'
  },
  preview: {
    pendingApproval: '等待批准',
    noMessagesYet: '还没有消息',
    draftTag: '[草稿]',
    planTag: '[计划]'
  },
  contextMenu: {
    select: '选择',
    continueChat: '继续聊天',
    star: '星标',
    unstar: '取消星标',
    regenerateTitle: '重新生成标题',
    handoff: '交接',
    createFolder: '创建文件夹',
    removeFromFolder: '移出文件夹',
    markItDefault: '标记为默认'
  },
  folder: {
    archiveAll: '全部归档',
    restoreAll: '全部恢复',
    discardFolder: '丢弃文件夹'
  },
  colors: {
    title: '颜色',
    markIt: '标记为{color}',
    coral: '珊瑚红',
    azure: '蔚蓝',
    emerald: '翡翠绿',
    amethyst: '紫水晶',
    slate: '石板灰'
  },
  filter: {
    all: '全部',
    running: '运行中',
    justDone: '刚完成',
    folderOnly: '仅文件夹',
    folders: '文件夹',
    filtersCount: '{count} 个筛选',
    filterChats: '筛选会话',
    filterChatsWith: '筛选会话：{label}',
    resetFilters: '重置筛选',
    status: '状态',
    workspace: '工作区',
    temporary: '临时',
    unreadCount: '{count} 条未读'
  },
  actions: {
    archive: '归档',
    restore: '恢复',
    saveMemoryAndArchive: '保存记忆并归档'
  },
  confirm: {
    archiveTitle: '归档“{title}”？',
    archiveManyTitle: { other: '归档 {count} 个会话？' },
    restoreManyTitle: { other: '恢复 {count} 个会话？' },
    deleteManyTitle: { other: '永久删除 {count} 个会话？' },
    archiveFolderTitle: { other: '归档“{title}”中的全部 {count} 个会话？' },
    restoreFolderTitle: { other: '恢复“{title}”中的全部 {count} 个会话？' },
    deleteTitle: '永久删除“{title}”？',
    activeRunTitle: '“{title}”有正在进行的运行。',
    activeRunMessage: '取消运行并删除该会话？'
  },
  errors: {
    rename: '重命名会话失败。',
    archive: '归档会话失败。',
    archiveMany: '归档所选会话失败。',
    archiveFolder: '归档文件夹中的会话失败。',
    restore: '恢复会话失败。',
    restoreMany: '恢复所选会话失败。',
    restoreFolder: '恢复文件夹中的会话失败。',
    delete: '删除会话失败。',
    deleteMany: '删除所选会话失败。',
    update: '更新会话失败。',
    updateIcon: '更新会话图标失败。',
    updateColor: '更新会话颜色失败。',
    regenerateTitles: '重新生成会话标题失败。',
    compact: '交接到其他会话失败。'
  }
}
