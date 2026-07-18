export const chat = {
  dismiss: '忽略',
  collapse: '收起',
  expand: '展开',
  noResults: '无结果',
  counts: {
    images: { other: '{count} 张图片' },
    files: { other: '{count} 个文件' },
    attachments: { other: '{count} 个附件' }
  },
  modes: {
    auto: {
      label: '自动模式',
      shortLabel: '自动',
      description: '使用全部已启用的工具进行编码、浏览、上下文与自动化。'
    },
    explore: {
      label: '探索模式',
      shortLabel: '探索',
      description: '读取和搜索文件、网页与已保存的上下文，不修改工作区。'
    },
    plan: {
      label: '计划模式',
      shortLabel: '计划',
      description: '先起草计划，可读取/搜索并访问计划文件。'
    },
    chat: {
      label: '聊天模式',
      shortLabel: '聊天',
      description: '仅基于现有对话和上下文回复。'
    }
  },
  reasoning: {
    title: '思考',
    off: { label: '关闭', description: '下次运行不使用思考控制' },
    low: { label: '低', description: '较小的思考预算' },
    medium: { label: '中', description: '均衡的思考预算' },
    high: { label: '高', description: '较大的思考预算' },
    xhigh: { label: '超高', description: '非常大的思考预算' },
    max: { label: '最大', description: '使用最大可用思考' }
  },
  composer: {
    dropFilesToAttach: '拖放文件以添加附件',
    editingMessage: '正在编辑消息',
    cancelEditing: '取消编辑',
    attach: '添加附件',
    modeAria: '模式:{mode}',
    modelSelection: '选择模型',
    reasoningEffort: '思考强度',
    skills: '技能',
    bufferingOnTooltip: '缓冲已开启 · 发送前合并连续消息',
    bufferingOffTooltip: '缓冲已关闭 · 立即发送',
    toggleBuffering: '切换输入缓冲',
    acpAgentFallback: 'ACP 智能体',
    configureProvider: '配置服务商',
    notConfiguredPlaceholder: '请先打开设置并配置服务商，然后开始聊天。',
    removeSkillTag: '移除技能 {name}',
    removeFileTag: '移除文件 {name}',
    searchingWorkspace: '正在搜索工作区…',
    noFilesFound: '当前工作区中未找到文件。',
    stopGeneration: '停止生成',
    steerReply: '引导回复',
    queueFollowUp: '排队追加消息',
    updateMessage: '更新消息',
    send: '发送',
    lastRunTokenUsage: '上次运行 token 用量',
    promptTokens: '提示',
    completionTokens: '补全',
    totalPromptTokens: '提示总计',
    totalCompletionTokens: '补全总计',
    draftEstimate: '草稿估算',
    contextOverLimit: '上下文已超过 {limit}。建议使用 {command} 压缩并在新会话中继续。',
    serverUnavailable: '本地服务不可用，请重新连接后再发送。',
    chooseProviderFirst: '发送前请先在设置中选择服务商和模型。',
    preparingFile: '正在准备文件…',
    preparingImage: '正在准备图片…',
    savingBackendSelection: '正在保存后端选择…',
    filePrepFailed: '此文件无法准备。',
    imagePrepFailed: '此图片无法准备。',
    enterQueuesFollowUp: '按 Enter 排队追加消息。',
    enterSteersHint: 'Enter 引导回复，Option+Enter 排队追加。',
    enterQueuesHint: 'Option+Enter 引导回复，Enter 排队追加。',
    acpRebindBlockedTitle: '请新建 ACP 会话',
    acpRebindBlockedBody: 'ACP 智能体只能在会话产生消息之前绑定。',
    editQueuedFollowUpFailed: '编辑排队消息失败。',
    removeQueuedFollowUpTitle: '移除这条排队的追加消息？',
    removeQueuedFollowUpFailed: '移除排队消息失败。',
    workspaceLockedRunningTitle: '运行中，工作区已锁定',
    workspaceLockedRunningDetail: '请等待当前运行结束后再切换工作区。',
    workspaceLockedPlanTitle: '待处理计划锁定了工作区',
    workspaceLockedPlanDetail: '请先接受或拒绝待处理的计划，再切换工作区。',
    tempWorkspaceDetail: '此会话未选择特定工作区。',
    switchWorkspaceTitle: '切换工作区？',
    switchWorkspaceDescription: '此会话之后的运行将使用所选工作区。',
    keepCurrentWorkspace: '保留当前工作区',
    switchWorkspace: '切换工作区',
    buffer: {
      merging: '正在合并下一条消息 · {seconds} 秒',
      mergingAria: '{seconds} 秒后合并下一条消息',
      attachmentsOnly: '(仅附件)',
      sendNow: '立即发送',
      sendNowAria: '立即发送已缓冲的消息',
      cancelAria: '取消已缓冲的消息',
      queuedFollowUp: '排队的追加消息',
      editQueuedAria: '编辑排队的追加消息',
      removeQueuedAria: '移除排队的追加消息'
    },
    todo: {
      taskProgress: '任务进度',
      stepCount: '{completed}/{total} 步',
      toggleAria: '展开或收起任务进度详情'
    },
    attachments: {
      statusLoading: '加载中',
      statusFailed: '需要处理',
      statusReady: '就绪',
      removeNamed: '移除 {name}',
      imageFallbackName: '图片',
      imageAltFallback: '所选图片',
      imageLabel: '图片',
      notAddedSingle: '{filename} 未添加:{reason}。',
      notAddedMany: '{count} 个文件未添加:{reason}。',
      reasonTooLargeLimit: '超出上传大小限制',
      reasonTooLarge: '超过 {size}',
      reasonSensitive: '敏感文件',
      reasonUnsupported: '不支持的文件类型',
      reasonMixed: '部分文件类型不支持、过大或涉及敏感内容',
      plainTextPasteFailed: '纯文本粘贴失败。',
      imagePrepError: '无法准备这张图片。',
      filePrepError: '无法准备这个文件。'
    },
    placeholdersCasual: {
      p1: '在想什么？',
      p2: '提问、吐槽，或者随便丢点什么给我。',
      p3: '我见过更离谱的，尽管来。',
      p4: '没有太怪的话题，也没有太半成品的想法。',
      p5: '今天我们要解决、创造还是纠结点什么？',
      p6: '八千年的耐心，随便用。',
      p7: '把那句你不确定值不值得说的话说出来。',
      p8: '卡住了？无聊？好奇？都可以。',
      p9: '先打字，逻辑稍后再说。',
      p10: '光标在闪，我也在。',
      p11: '你的思路在这里不需要刹车。',
      p12: '一起做点什么、拆点什么，或者就聊聊。',
      p13: '你假装不想问的那件事，是什么？',
      p14: '没有什么事太小，我有的是时间。'
    },
    placeholdersPlan: {
      p1: '目标是什么，阻碍又是什么？',
      p2: '拆开说，我来起草步骤。',
      p3: '从问题开始，我们一起计划修复。',
      p4: '我们要构建或改变什么？',
      p5: '描述你想要的结果，我来规划路径。',
      p6: '任务很大？让我切成小块。',
      p7: '说出目标，我来勾勒思路。',
      p8: '这个计划需要遵守哪些约束？',
      p9: '把情况讲给我听，我来列出行动。',
      p10: '开工前需要一个策略？',
      p11: '"完成"长什么样？',
      p12: '把难题丢给我，我先把边角理清。',
      p13: '随时可以开始，我们要计划什么？',
      p14: '乱一点没关系，计划会把它理顺。'
    }
  },
  modelPicker: {
    searchModels: '搜索模型…',
    openProviderSettings: '打开服务商设置',
    noModelsFound: '未找到模型',
    acpAgentsDeprecated: 'ACP 智能体(已弃用)'
  },
  slashCommands: {
    ariaLabel: '斜杠命令',
    tabComplete: 'Tab 补全',
    enterSelect: 'Enter 选择',
    escClose: 'Esc 关闭',
    handoff: 'Handoff',
    handoffDescription: '压缩到新会话继续',
    archive: 'Archive',
    archiveDescription: '归档此会话',
    skills: 'Skills',
    browseSkills: { other: '浏览 {count} 个可用技能' },
    noDescription: '暂无描述',
    latestJotDown: '最新随手记',
    ignoredWorkspacePath: '被忽略的工作区路径',
    workspacePath: '工作区路径'
  },
  skillsPicker: {
    ariaLabel: '选择技能',
    title: '技能',
    openSkillSettings: '打开技能设置',
    overrideNote: '输入框中的选择会在下次发送时覆盖设置。',
    useSettingsDefaults: '使用设置默认值',
    resetOverride: '重置此输入框覆盖。',
    currentlyActive: '当前生效。',
    reset: '重置',
    using: '使用中',
    noSkillsAvailable: '当前工作区暂无可用技能。',
    noSummary: '暂无摘要。'
  },
  modePicker: {
    title: '模式',
    ariaLabel: '运行模式',
    activeRunNote: '当前运行保持原有模式，更改将应用于下次发送。',
    nextSendNote: '下次发送将使用此模式。'
  },
  workspacePicker: {
    title: '工作区',
    ariaLabel: '选择工作区',
    openWorkspaceSettings: '打开工作区设置',
    tempNote: '临时工作区表示此会话未固定任何文件夹。',
    tempWorkspace: '临时工作区',
    tempDescription: '使用默认的会话级临时目录',
    selectDirectory: '选择目录…',
    suggestionTitle: '切换到工作区"{name}"?',
    switch: '切换',
    notChangedTitle: '工作区未更改',
    cannotChange: '此会话无法更改工作区。',
    unableToChange: '无法更改工作区。',
    confirmSwitchTitle: '将此会话切换到其他工作区？',
    confirmSwitchDescription: '此会话之后的运行将使用所选工作区，现有消息和文件保持不变。'
  },
  timeline: {
    emptyThreadPrompt: '新建会话，或在下方输入以自动创建。',
    noMessagesYet: '暂无消息',
    recap: '回顾:',
    deleteRequestTitle: '删除这条请求？',
    deleteRequestMessage: '当前会话中它之后的所有回复分支都将被删除。',
    deleteBranchTitle: '删除这个回复分支？',
    deleteBranchMessage: '由它延续的所有内容都将被删除，其他并列回复会保留。',
    createBranchFailed: '创建分支失败。',
    retryFailed: '重试此消息失败。',
    deleteFailed: '删除此消息失败。',
    switchBranchFailed: '切换回复分支失败。',
    pendingSteer: '待发送引导',
    stopped: '已停止',
    failedToGenerate: '生成失败',
    failedWithError: '失败:{error}',
    memoriesSaved: { other: '已保存 {count} 条记忆' },
    generating: '正在生成…',
    retrying: '正在重试({attempt}/{max})',
    thinking: '思考中 · {elapsed}',
    thought: '思考过程',
    handoffFold: { other: '上下文交接 · {count} 条消息' },
    replyCount: '{count} 条回复',
    previousReplyAria: '查看上一个回复分支',
    nextReplyAria: '查看下一个回复分支',
    roleYou: '你',
    roleAssistant: '助手',
    snippetEmpty: '(空)',
    imageAlt: '图片 {index}',
    selectThread: '选择一个会话查看'
  },
  messageActions: {
    ariaLabel: '消息操作',
    copyFailed: '复制失败',
    branch: '分支',
    revertToComposer: '撤回到输入框',
    deleteFromHere: '从这里开始删除'
  },
  tools: {
    input: '输入',
    output: '输出',
    metadata: '元数据',
    status: {
      preparing: '准备中',
      running: '运行中',
      failed: '失败',
      waiting: '等待中',
      background: '后台',
      completed: '已完成'
    },
    expandDetailsAria: '展开 {name} 详情',
    collapseDetailsAria: '收起 {name} 详情',
    waitingForToolCalls: '等待工具调用',
    askUserTypeAnswer: '输入你的回答…',
    askUserOrTypeAnswer: '或输入你的回答…',
    groups: {
      searchSources: {
        active: { other: '正在搜索 {count} 个来源' },
        done: { other: '已搜索 {count} 个来源' }
      },
      readSources: {
        active: { other: '正在阅读 {count} 个来源' },
        done: { other: '已阅读 {count} 个来源' }
      },
      searchFiles: {
        active: { other: '正在搜索 {count} 个模式' },
        done: { other: '已搜索 {count} 个模式' }
      },
      readFiles: {
        active: { other: '正在读取 {count} 个文件' },
        done: { other: '已读取 {count} 个文件' }
      },
      editFiles: {
        active: { other: '正在编辑 {count} 个文件' },
        done: { other: '已编辑 {count} 个文件' }
      },
      writeFiles: {
        active: { other: '正在写入 {count} 个文件' },
        done: { other: '已写入 {count} 个文件' }
      },
      runCommands: {
        active: { other: '正在运行 {count} 条命令' },
        done: { other: '已运行 {count} 条命令' }
      },
      inspectWorkspace: {
        active: { one: '正在检查工作区', other: '正在检查工作区 · {count} 条命令' },
        done: { one: '已检查工作区', other: '已检查工作区 · {count} 条命令' }
      },
      evaluateCode: {
        active: { one: '正在执行 JavaScript', other: '正在执行 JavaScript · {count} 段代码' },
        done: { one: '已执行 JavaScript', other: '已执行 JavaScript · {count} 段代码' }
      },
      querySources: {
        active: { one: '正在查询源数据', other: '正在查询源数据 · {count} 次' },
        done: { one: '已查询源数据', other: '已查询源数据 · {count} 次' }
      },
      readingFiles: '正在读取文件',
      readFilesDone: '已读取文件',
      editingFiles: '正在编辑文件',
      editedFilesDone: '已编辑文件',
      writingFiles: '正在写入文件',
      wroteFilesDone: '已写入文件'
    }
  },
  workSummary: {
    title: '工作摘要',
    actionsCount: '{count} 项操作',
    filesCount: '{count} 个文件',
    needReview: { other: '{count} 项操作需要检查' },
    activityAndNotes: '活动与备注',
    review: '审阅',
    fileChanges: '文件变更',
    reviewFileChanges: { other: '审阅 {count} 项文件变更' },
    labelContext: '上下文',
    labelNote: '备注',
    labelUserSteer: '用户引导',
    labelAction: '操作',
    branchFromHere: '从这里分支'
  },
  runStats: {
    toolCalls: { other: '{count} 次工具调用' },
    fileChanges: { other: '{count} 项文件变更' }
  },
  backgroundTasks: {
    running: { other: '{count} 个后台任务运行中' },
    total: { other: '{count} 个后台任务' },
    title: '后台任务',
    clearDone: '清除 {count} 个已完成',
    cancelTask: '取消任务',
    statusCancelled: '已取消',
    statusFailed: '失败(退出码 {code})',
    statusDone: '完成(退出码 {code})',
    fullCommand: '完整命令',
    logOutput: '日志输出',
    loadingLog: '正在加载完整日志…',
    showingLast: '显示最后 {shown} / 共 {total}',
    noOutputYet: '(暂无输出)',
    loadLogFailed: '无法加载完整日志。'
  },
  subagents: {
    prompt: '提示词',
    recentToolCalls: '最近的工具调用',
    latestOfTotal: '最近 {shown}/{total}',
    noActiveAgents: '没有活跃的智能体',
    agentWorking: '{name} 正在工作',
    agentsWorking: '{count} 个智能体正在工作',
    agentFallback: '智能体',
    interrupt: '中断？',
    stop: '停止',
    continue: '继续',
    stopRunToCancel: '停止运行可取消全部',
    resultDone: '完成',
    resultStopped: '已停止',
    tokens: '{count} token'
  },
  diff: {
    revertAll: '全部还原',
    loadFailed: '加载变更失败。',
    noFileChanges: '没有文件变更。',
    openInApp: '在 {app} 中打开',
    reverted: '已还原',
    revert: '还原',
    allReverted: '所有变更均已还原。',
    revertFileTitle: '还原文件',
    revertAllTitle: '还原全部变更',
    revertFileDescription: '这会将 {path} 恢复到之前的状态，且无法撤销。',
    revertAllDescription: '这会将所有文件恢复到之前的状态，且无法撤销。',
    reverting: '正在还原…',
    revealInFinder: '在访达中显示',
    openInEditorFailed: '在编辑器中打开失败。'
  },
  plan: {
    title: '计划',
    accepted: '已接受',
    rejected: '已拒绝',
    ready: '就绪',
    reject: '拒绝',
    acceptDirectly: '直接接受',
    acceptWithHandoff: '接受并交接',
    rejectedNote: '计划已拒绝，发送修改意见以继续。'
  },
  memoryRecall: {
    recalled: { other: '召回 {count} 条记忆' },
    expandAria: '展开召回的记忆',
    collapseAria: '收起召回的记忆',
    reason: '原因:{reason}',
    novelTerms: '新词条:{terms}',
    reasonNewTopic: '新话题',
    reasonRecallFailed: '召回失败',
    reasonManual: '手动/未知'
  },
  findBar: {
    placeholder: '在会话中查找…',
    position: '第 {current} 项，共 {total} 项',
    previousMatch: '上一个匹配',
    nextMatch: '下一个匹配',
    close: '关闭查找栏'
  },
  browser: {
    noSessions: '没有浏览器会话',
    sessionsAppearHere: '由 useBrowser 打开的浏览器会话会显示在这里。',
    showSessionFailed: '无法显示浏览器会话。',
    sessionsAria: '浏览器会话',
    conversationTab: '对话',
    browserTab: '浏览器',
    surfaceAria: '会话视图'
  }
}
