export const layout = {
  tabs: {
    work: '工作',
    things: '事项',
    archived: '归档',
    settings: '设置'
  },
  tabBar: {
    appSections: '应用分区',
    versionAvailable: 'v{version} 可用',
    updateAvailable: '有可用更新',
    installUpdate: '安装更新',
    update: '更新',
    more: '更多',
    moreOptions: '更多选项'
  },
  sidebar: {
    threadCount: { other: '{count} 个会话' },
    searchArchivedChats: '搜索归档会话',
    markAllAsRead: '全部标为已读',
    searchChats: '搜索会话',
    newChat: '新会话'
  },
  utilityMenu: {
    serverReady: '服务已就绪',
    serverOffline: '服务离线',
    externalThreads: '外部会话',
    onBadge: '开',
    translator: '翻译',
    jotDown: '随手记'
  },
  header: {
    loadingWorkspace: '正在加载本地工作区...',
    messageCount: { other: '{count} 条消息' },
    noMessagesYet: '还没有消息',
    startConversation: '开始对话',
    threadOptions: '会话选项',
    openWorkspaceInFinder: '在访达中打开工作区',
    openWorkspaceInTerminal: '在终端中打开工作区',
    openWorkspaceInEditor: '在编辑器中打开工作区',
    openRunInspector: '打开运行检查器',
    closeRunInspector: '关闭运行检查器',
    privacy: {
      lockedOn: '隐私模式：已锁定（开）',
      lockedOff: '隐私模式：已锁定（关）',
      on: '隐私模式：开',
      off: '隐私模式：关',
      descLockedOn: '记忆召回与提炼已禁用 — 发送消息后无法更改',
      descLockedOff: '发送消息后无法更改',
      descOn: '记忆召回与提炼已禁用',
      descOff: '开启后此会话将不进入记忆'
    }
  },
  welcome: {
    greeting1: '我们从哪里开始？',
    greeting2: '今天做点什么？',
    greeting3: '把最乱的部分交给我吧。',
    greeting4: '随时可以开始。',
    slogan1: '先随便写写，我们再一起打磨。',
    slogan2: '丢进来一个想法、一个文件，或半成形的计划。',
    slogan3: '把乱麻粘贴到这里 — Yachiyo 会接着处理。',
    slogan4: '一句简短的提示就足够开始。',
    creationWith: '与之共创',
    essentialFallback: 'Essential',
    essentialSlogan: '发送第一条消息，与这个 Essential 开启一个专注会话。',
    savingToMemory: '正在保存到记忆…',
    interactionsPaused: '会话交互已暂停'
  },
  sparks: {
    pulse: { label: '脉搏', hint: '回顾昨天做了什么' },
    sisyphus: { label: '西西弗斯', hint: '找出总在原地打转的工作' },
    grill: { label: '拷问', hint: '把模糊想法拷问成真正的计划' },
    mirror: { label: '镜像', hint: '审视 Yachiyo 对你的认知' },
    constellation: { label: '星图', hint: '发现工作之间的隐藏关联' },
    brainstorm: { label: '头脑风暴', hint: '从一个主题和你已有的东西开始发散' }
  },
  archived: {
    title: '归档',
    heading: '归档会话',
    selectPrompt: '从侧边栏选择一个归档会话查看。',
    noMessages: '暂无消息',
    continueChat: '继续聊天',
    deletePermanently: '永久删除',
    scheduleResult: '计划任务结果',
    startedAt: '开始于 {time}',
    finishedAt: '结束于 {time}',
    tokens: '{tokens} tokens'
  },
  dialogs: {
    renameThreadTitle: '重命名会话'
  },
  browserActivity: {
    responding: '正在回复',
    latestResponse: '最新回复',
    browserStep: '浏览器步骤',
    stepInSession: '在 {session} 中{action}'
  },
  errors: {
    togglePrivacy: '切换隐私模式失败。',
    openWorkspace: '打开工作区失败。',
    openEditor: '在编辑器中打开失败。',
    openTerminal: '在终端中打开失败。',
    startChat: '启动会话失败。',
    saveSidebarVisibility: '保存侧边栏可见性失败。'
  }
}
