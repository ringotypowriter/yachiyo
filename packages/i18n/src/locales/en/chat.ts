export const chat = {
  dismiss: 'Dismiss',
  collapse: 'Collapse',
  expand: 'Expand',
  noResults: 'No results',
  counts: {
    images: { one: '{count} image', other: '{count} images' },
    files: { one: '{count} file', other: '{count} files' },
    attachments: { one: '{count} attachment', other: '{count} attachments' }
  },
  modes: {
    auto: {
      label: 'Auto Mode',
      shortLabel: 'Auto',
      description: 'Use every enabled tool for coding, browsing, context, and automation.'
    },
    explore: {
      label: 'Explore Mode',
      shortLabel: 'Explore',
      description: 'Read and search files, web, and saved context. No workspace edits.'
    },
    plan: {
      label: 'Plan Mode',
      shortLabel: 'Plan',
      description: 'Draft a plan first, with read/search and plan-file access.'
    },
    chat: {
      label: 'Chat Mode',
      shortLabel: 'Chat',
      description: 'Reply from the existing conversation and context.'
    }
  },
  reasoning: {
    title: 'Reasoning',
    off: { label: 'Off', description: 'No reasoning controls for the next run' },
    low: { label: 'Low', description: 'Small reasoning budget' },
    medium: { label: 'Medium', description: 'Balanced reasoning budget' },
    high: { label: 'High', description: 'Larger reasoning budget' },
    xhigh: { label: 'XHigh', description: 'Very large reasoning budget' },
    max: { label: 'Max', description: 'Maximum available reasoning' }
  },
  composer: {
    dropFilesToAttach: 'Drop files to attach',
    editingMessage: 'Editing message',
    cancelEditing: 'Cancel editing',
    attach: 'Attach',
    modeAria: 'Mode: {mode}',
    modelSelection: 'Model selection',
    reasoningEffort: 'Reasoning effort',
    skills: 'Skills',
    bufferingOnTooltip: 'Buffering on · merges rapid messages before send',
    bufferingOffTooltip: 'Buffering off · send immediately',
    toggleBuffering: 'Toggle input buffering',
    acpAgentFallback: 'ACP Agent',
    configureProvider: 'Configure provider',
    notConfiguredPlaceholder: 'Open Settings and configure a provider before chatting.',
    removeSkillTag: 'Remove skill {name}',
    removeFileTag: 'Remove file {name}',
    searchingWorkspace: 'Searching workspace...',
    noFilesFound: 'No files found in the current workspace.',
    stopGeneration: 'Stop generation',
    steerReply: 'Steer reply',
    queueFollowUp: 'Queue follow-up',
    updateMessage: 'Update message',
    send: 'Send',
    lastRunTokenUsage: 'Last run token usage',
    promptTokens: 'Prompt',
    completionTokens: 'Completion',
    totalPromptTokens: 'Total prompt',
    totalCompletionTokens: 'Total completion',
    draftEstimate: 'Draft estimate',
    contextOverLimit:
      'Context is over {limit}. Consider using {command} to compact and continue in a new thread.',
    serverUnavailable: 'Local server is unavailable. Reconnect before sending.',
    chooseProviderFirst: 'Choose a provider and model in Settings before sending.',
    preparingFile: 'Preparing file...',
    preparingImage: 'Preparing image...',
    savingBackendSelection: 'Saving backend selection...',
    filePrepFailed: 'This file could not be prepared.',
    imagePrepFailed: 'This image could not be prepared.',
    enterQueuesFollowUp: 'Enter to queue follow-up.',
    enterSteersHint: 'Enter to steer, Option+Enter to queue follow-up.',
    enterQueuesHint: 'Option+Enter to steer, Enter to queue follow-up.',
    acpRebindBlockedTitle: 'Start a new ACP thread',
    acpRebindBlockedBody: 'ACP agents can only be attached before a thread has any messages.',
    editQueuedFollowUpFailed: 'Failed to edit queued follow-up.',
    removeQueuedFollowUpTitle: 'Remove this queued follow-up?',
    removeQueuedFollowUpFailed: 'Failed to remove queued follow-up.',
    workspaceLockedRunningTitle: 'Workspace locked while running',
    workspaceLockedRunningDetail: 'Wait for the current run to finish before switching workspace.',
    workspaceLockedPlanTitle: 'Workspace locked by pending plan',
    workspaceLockedPlanDetail: 'Accept or reject the pending plan before switching workspace.',
    tempWorkspaceDetail: 'No specific workspace selected for this thread.',
    switchWorkspaceTitle: 'Switch workspace?',
    switchWorkspaceDescription: 'Future runs in this thread will use the selected workspace.',
    keepCurrentWorkspace: 'Keep current workspace',
    switchWorkspace: 'Switch workspace',
    buffer: {
      merging: 'Merging next message · {seconds}s',
      mergingAria: 'Merging next message in {seconds}s',
      attachmentsOnly: '(attachments only)',
      sendNow: 'Send now',
      sendNowAria: 'Send buffered message now',
      cancelAria: 'Cancel buffered message',
      queuedFollowUp: 'Queued follow-up',
      editQueuedAria: 'Edit queued follow-up',
      removeQueuedAria: 'Remove queued follow-up'
    },
    todo: {
      taskProgress: 'Task progress',
      stepCount: '{completed}/{total} Step',
      toggleAria: 'Toggle task progress details'
    },
    attachments: {
      statusLoading: 'Loading',
      statusFailed: 'Needs attention',
      statusReady: 'Ready',
      removeNamed: 'Remove {name}',
      imageFallbackName: 'image',
      imageAltFallback: 'Selected image',
      imageLabel: 'Image',
      notAddedSingle: '{filename} was not added: {reason}.',
      notAddedMany: '{count} files were not added: {reason}.',
      reasonTooLargeLimit: 'larger than the upload limit',
      reasonTooLarge: 'larger than {size}',
      reasonSensitive: 'sensitive file',
      reasonUnsupported: 'unsupported file type',
      reasonMixed: 'some were unsupported, too large, or sensitive',
      plainTextPasteFailed: 'Plain-text paste failed.',
      imagePrepError: 'Unable to prepare this image.',
      filePrepError: 'Unable to prepare this file.'
    },
    placeholdersCasual: {
      p1: "What's on your mind?",
      p2: 'Ask, vent, or throw words at me.',
      p3: "I've seen worse. Try me.",
      p4: 'No topic too weird, no thought too half-baked.',
      p5: 'What are we solving, making, or overthinking today?',
      p6: 'Eight thousand years of patience. Use it.',
      p7: "Say the thing you're not sure is worth saying.",
      p8: 'Stuck? Bored? Curious? All valid.',
      p9: 'Type first, coherence later.',
      p10: 'The cursor is blinking. So am I.',
      p11: 'Your train of thought has no brakes here.',
      p12: "Let's make something, break something, or just talk.",
      p13: "What's the thing you're pretending you don't want to ask?",
      p14: "Nothing's too small. I've got time."
    },
    placeholdersPlan: {
      p1: "What's the goal, and what's in the way?",
      p2: 'Break it down. I will draft the steps.',
      p3: 'Start with the problem. We will plan the fix.',
      p4: 'What are we building or changing?',
      p5: 'Describe the outcome you want, and I will map the path.',
      p6: 'Big task? Let me cut it into pieces.',
      p7: 'State the objective. I will sketch the approach.',
      p8: 'What constraints should the plan respect?',
      p9: 'Walk me through the situation. I will outline the moves.',
      p10: 'Need a strategy before the work begins?',
      p11: 'What does done look like?',
      p12: 'Throw me the puzzle. I will sort the edges first.',
      p13: 'Ready when you are. What are we planning?',
      p14: 'Start messy. The plan will clean it up.'
    }
  },
  modelPicker: {
    searchModels: 'Search models...',
    openProviderSettings: 'Open provider settings',
    noModelsFound: 'No models found',
    acpAgentsDeprecated: 'ACP Agents (Deprecated)'
  },
  slashCommands: {
    ariaLabel: 'Slash commands',
    tabComplete: 'Tab complete',
    enterSelect: 'Enter select',
    escClose: 'Esc close',
    handoff: 'Handoff',
    handoffDescription: 'Compact into a new thread',
    archive: 'Archive',
    archiveDescription: 'Archive this thread',
    skills: 'Skills',
    browseSkills: {
      one: 'Browse {count} available skill',
      other: 'Browse {count} available skills'
    },
    noDescription: 'No description available',
    latestJotDown: 'Latest jot down',
    ignoredWorkspacePath: 'Ignored workspace path',
    workspacePath: 'Workspace path'
  },
  skillsPicker: {
    ariaLabel: 'Skill selection',
    title: 'Skills',
    openSkillSettings: 'Open skill settings',
    overrideNote: 'Composer choices override Settings for the next send.',
    useSettingsDefaults: 'Use Settings defaults',
    resetOverride: 'Reset this composer override.',
    currentlyActive: 'Currently active.',
    reset: 'Reset',
    using: 'Using',
    noSkillsAvailable: 'No Skills are available in this workspace right now.',
    noSummary: 'No summary available.'
  },
  modePicker: {
    title: 'Mode',
    ariaLabel: 'Run mode',
    activeRunNote: 'The current run keeps its existing mode. Your change applies to the next send.',
    nextSendNote: 'Your next send uses this mode.'
  },
  workspacePicker: {
    title: 'Workspace',
    ariaLabel: 'Workspace selection',
    openWorkspaceSettings: 'Open workspace settings',
    tempNote: 'Temp workspace means no specific folder is pinned to this thread.',
    tempWorkspace: 'Temp workspace',
    tempDescription: 'Use the default per-thread temp directory',
    selectDirectory: 'Select directory...',
    suggestionTitle: 'Switch to workspace "{name}"?',
    switch: 'Switch',
    notChangedTitle: 'Workspace not changed',
    cannotChange: 'This thread cannot change workspace.',
    unableToChange: 'Unable to change the workspace.',
    confirmSwitchTitle: 'Switch this thread to a different workspace?',
    confirmSwitchDescription:
      'Future runs in this thread will use the selected workspace. Existing messages and files stay where they are.'
  },
  timeline: {
    emptyThreadPrompt: 'Start a new thread or type below to create one automatically.',
    noMessagesYet: 'No messages yet',
    recap: 'Recap:',
    deleteRequestTitle: 'Delete this request?',
    deleteRequestMessage:
      'Every attached response branch after it in the current thread will be deleted.',
    deleteBranchTitle: 'Delete this response branch?',
    deleteBranchMessage:
      'Everything that continues from it will be deleted. Sibling responses will stay.',
    createBranchFailed: 'Failed to create a branch.',
    retryFailed: 'Failed to retry this message.',
    deleteFailed: 'Failed to delete this message.',
    switchBranchFailed: 'Failed to switch reply branches.',
    pendingSteer: 'Pending steer',
    stopped: 'Stopped',
    failedToGenerate: 'Failed to generate',
    failedWithError: 'Failed: {error}',
    memoriesSaved: { one: 'Memory saved', other: '{count} memories saved' },
    generating: 'Generating...',
    retrying: 'Retrying ({attempt}/{max})',
    thinking: 'Thinking · {elapsed}',
    thought: 'Thought',
    handoffFold: {
      one: 'Context handoff · {count} message',
      other: 'Context handoff · {count} messages'
    },
    replyCount: '{count} replies',
    previousReplyAria: 'Show previous reply branch',
    nextReplyAria: 'Show next reply branch',
    roleYou: 'You',
    roleAssistant: 'Assistant',
    snippetEmpty: '(empty)',
    imageAlt: 'Image {index}',
    selectThread: 'Select a thread to view'
  },
  messageActions: {
    ariaLabel: 'Message actions',
    copyFailed: 'Copy failed',
    branch: 'Branch',
    revertToComposer: 'Revert to composer',
    deleteFromHere: 'Delete from here'
  },
  tools: {
    input: 'Input',
    output: 'Output',
    metadata: 'Metadata',
    status: {
      preparing: 'preparing',
      running: 'running',
      failed: 'failed',
      waiting: 'waiting',
      background: 'background',
      completed: 'completed'
    },
    expandDetailsAria: 'Expand {name} details',
    collapseDetailsAria: 'Collapse {name} details',
    waitingForToolCalls: 'Waiting for tool calls',
    askUserTypeAnswer: 'Type your answer...',
    askUserOrTypeAnswer: 'Or type your answer...',
    groups: {
      searchSources: {
        active: { one: 'Searching {count} source', other: 'Searching {count} sources' },
        done: { one: 'Searched {count} source', other: 'Searched {count} sources' }
      },
      readSources: {
        active: { one: 'Reading {count} source', other: 'Reading {count} sources' },
        done: { one: 'Read {count} source', other: 'Read {count} sources' }
      },
      searchFiles: {
        active: { one: 'Searching {count} pattern', other: 'Searching {count} patterns' },
        done: { one: 'Searched {count} pattern', other: 'Searched {count} patterns' }
      },
      readFiles: {
        active: { one: 'Reading {count} file', other: 'Reading {count} files' },
        done: { one: 'Read {count} file', other: 'Read {count} files' }
      },
      editFiles: {
        active: { one: 'Editing {count} file', other: 'Editing {count} files' },
        done: { one: 'Edited {count} file', other: 'Edited {count} files' }
      },
      writeFiles: {
        active: { one: 'Writing {count} file', other: 'Writing {count} files' },
        done: { one: 'Wrote {count} file', other: 'Wrote {count} files' }
      },
      runCommands: {
        active: { one: 'Running {count} command', other: 'Running {count} commands' },
        done: { one: 'Ran {count} command', other: 'Ran {count} commands' }
      },
      inspectWorkspace: {
        active: {
          one: 'Inspecting workspace',
          other: 'Inspecting workspace · {count} commands'
        },
        done: { one: 'Inspected workspace', other: 'Inspected workspace · {count} commands' }
      },
      evaluateCode: {
        active: {
          one: 'Evaluating JavaScript',
          other: 'Evaluating JavaScript · {count} snippets'
        },
        done: { one: 'Evaluated JavaScript', other: 'Evaluated JavaScript · {count} snippets' }
      },
      querySources: {
        active: { one: 'Querying source data', other: 'Querying source data · {count} times' },
        done: { one: 'Queried source data', other: 'Queried source data · {count} times' }
      },
      readingFiles: 'Reading files',
      readFilesDone: 'Read files',
      editingFiles: 'Editing files',
      editedFilesDone: 'Edited files',
      writingFiles: 'Writing files',
      wroteFilesDone: 'Wrote files'
    }
  },
  workSummary: {
    title: 'Work Summary',
    actionsCount: '{count} actions',
    filesCount: '{count} files',
    needReview: { one: '{count} action need review', other: '{count} actions need review' },
    activityAndNotes: 'Activity and notes',
    review: 'Review',
    fileChanges: 'File changes',
    reviewFileChanges: { one: 'Review {count} file change', other: 'Review {count} file changes' },
    labelContext: 'Context',
    labelNote: 'Note',
    labelUserSteer: 'User steer',
    labelAction: 'Action'
  },
  runStats: {
    toolCalls: { one: '{count} tool call', other: '{count} tool calls' },
    fileChanges: { one: '{count} file change', other: '{count} file changes' }
  },
  backgroundTasks: {
    running: {
      one: '{count} background task running',
      other: '{count} background tasks running'
    },
    total: { one: '{count} background task', other: '{count} background tasks' },
    title: 'Background tasks',
    clearDone: 'Clear {count} done',
    cancelTask: 'Cancel task',
    statusCancelled: 'cancelled',
    statusFailed: 'failed (exit {code})',
    statusDone: 'done (exit {code})',
    fullCommand: 'Full command',
    logOutput: 'Log output',
    loadingLog: 'Loading full log...',
    showingLast: 'Showing last {shown} of {total}',
    noOutputYet: '(no output yet)',
    loadLogFailed: 'Could not load full log.'
  },
  subagents: {
    prompt: 'Prompt',
    recentToolCalls: 'Recent tool calls',
    latestOfTotal: 'latest {shown}/{total}',
    noActiveAgents: 'No active agents',
    agentWorking: '{name} is working',
    agentsWorking: '{count} agents are working',
    agentFallback: 'Agent',
    interrupt: 'Interrupt?',
    stop: 'Stop',
    continue: 'Continue',
    stopRunToCancel: 'Stop the run to cancel all',
    resultDone: 'done',
    resultStopped: 'stopped',
    tokens: '{count} tokens'
  },
  diff: {
    revertAll: 'Revert all',
    loadFailed: 'Failed to load changes.',
    noFileChanges: 'No file changes.',
    openInApp: 'Open in {app}',
    reverted: 'Reverted',
    revert: 'Revert',
    allReverted: 'All changes have been reverted.',
    revertFileTitle: 'Revert file',
    revertAllTitle: 'Revert all changes',
    revertFileDescription: 'This will restore {path} to its previous state. This cannot be undone.',
    revertAllDescription:
      'This will restore all files to their previous state. This cannot be undone.',
    reverting: 'Reverting...',
    revealInFinder: 'Reveal in Finder',
    openInEditorFailed: 'Failed to open in editor.'
  },
  plan: {
    title: 'Plan',
    accepted: 'Accepted',
    rejected: 'Rejected',
    ready: 'Ready',
    reject: 'Reject',
    acceptDirectly: 'Accept directly',
    acceptWithHandoff: 'Accept with handoff',
    rejectedNote: 'Plan rejected. Send revision notes to continue.'
  },
  memoryRecall: {
    recalled: { one: '{count} recalled memory', other: '{count} recalled memories' },
    expandAria: 'Expand recalled memory',
    collapseAria: 'Collapse recalled memory',
    reason: 'Reason: {reason}',
    novelTerms: 'Novel terms: {terms}',
    reasonNewTopic: 'new topic',
    reasonRecallFailed: 'recall failed',
    reasonManual: 'manual/unknown'
  },
  findBar: {
    placeholder: 'Find in thread…',
    position: '{current} of {total}',
    previousMatch: 'Previous match',
    nextMatch: 'Next match',
    close: 'Close find bar'
  },
  browser: {
    noSessions: 'No browser sessions',
    sessionsAppearHere: 'Browser sessions opened by useBrowser will appear here.',
    showSessionFailed: 'Unable to show the browser session.',
    sessionsAria: 'Browser sessions',
    conversationTab: 'Conversation',
    browserTab: 'Browser',
    surfaceAria: 'Thread surface'
  }
} as const
