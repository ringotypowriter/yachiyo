import type {
  MessageRecord,
  ScheduleRecord,
  ScheduleRunRecord,
  SettingsConfig,
  ThreadRecord,
  ToolCallRecord
} from '../../../shared/yachiyo/protocol.ts'
import { withThreadCapabilities } from '../../../shared/yachiyo/protocol.ts'
import { createInMemoryYachiyoStorage } from '../storage/memoryStorage.ts'
import type { YachiyoStorage } from '../storage/storage.ts'

const DEMO_WORKSPACE_PATH = process.cwd()
const DEMO_BRIEF_PATH = `${DEMO_WORKSPACE_PATH}/docs/launch-brief.md`
const DEMO_PRICING_DOC_PATH = `${DEMO_WORKSPACE_PATH}/docs/provider-pricing.md`

export function isDevelopmentDemoModeEnabled(
  config: Pick<SettingsConfig, 'general'>,
  isDevelopment: boolean
): boolean {
  return isDevelopment && config.general?.demoMode === true
}

export function createDemoYachiyoStorage(): YachiyoStorage {
  const storage = createInMemoryYachiyoStorage()
  seedDemoStorage(storage)
  return storage
}

function seedDemoStorage(storage: YachiyoStorage): void {
  seedChannelRecords(storage)
  const agenticThread = createAgenticChatThread(storage)
  const dispatchThread = createCodingDispatchThread(storage)
  const branchingThread = createReplyBranchingThread(storage)
  createSidebarThreads(storage)
  createArchivedHandoffThread(storage)
  createSchedules(storage, {
    agenticThreadId: agenticThread.id,
    dispatchThreadId: dispatchThread.id,
    branchingThreadId: branchingThread.id
  })
}

function seedChannelRecords(storage: YachiyoStorage): void {
  storage.createChannelUser({
    id: 'demo-channel-user-telegram-maya',
    platform: 'telegram',
    externalUserId: 'maya_chen',
    username: 'Maya Chen',
    label: '',
    status: 'allowed',
    role: 'owner',
    usageLimitKTokens: 600,
    workspacePath: DEMO_WORKSPACE_PATH
  })
  storage.createChannelUser({
    id: 'demo-channel-user-discord-ops',
    platform: 'discord',
    externalUserId: 'ops_lead_2049',
    username: 'ops-lead',
    label: '',
    status: 'allowed',
    role: 'guest',
    usageLimitKTokens: 300,
    workspacePath: DEMO_WORKSPACE_PATH
  })
  storage.createChannelGroup({
    id: 'demo-channel-group-launch-war-room',
    platform: 'discord',
    externalGroupId: 'launch-war-room',
    name: 'launch-war-room',
    label: '',
    status: 'approved',
    workspacePath: DEMO_WORKSPACE_PATH
  })
}

function createAgenticChatThread(storage: YachiyoStorage): ThreadRecord {
  const kickoffUserMessage: MessageRecord = {
    id: 'demo-msg-agentic-user-setup-1',
    threadId: 'demo-thread-agentic-chat',
    role: 'user',
    content:
      'The current demo thread still reads like a toy example. I need one thread that feels like a real work session: research, compare sources, patch a file, and report back cleanly.',
    status: 'completed',
    createdAt: '2026-04-03T09:46:12.000Z'
  }
  const kickoffAssistantMessage: MessageRecord = {
    id: 'demo-msg-agentic-assistant-setup-1',
    threadId: 'demo-thread-agentic-chat',
    parentMessageId: kickoffUserMessage.id,
    role: 'assistant',
    content:
      'Then I should stage it like an actual operator pass: align on the goal, inspect the current docs, verify the live source, make the edit, and close with a summary that says exactly what changed.',
    status: 'completed',
    createdAt: '2026-04-03T09:46:58.000Z',
    providerName: 'work',
    modelId: 'gpt-5'
  }
  const framingUserMessage: MessageRecord = {
    id: 'demo-msg-agentic-user-setup-1b',
    threadId: 'demo-thread-agentic-chat',
    role: 'user',
    content:
      'Right. Open by defining success, not by jumping straight into tools. I want to see the agent decide what “done” means before it touches the docs.',
    status: 'completed',
    createdAt: '2026-04-03T09:47:32.000Z'
  }
  const framingAssistantMessage: MessageRecord = {
    id: 'demo-msg-agentic-assistant-setup-1b',
    threadId: 'demo-thread-agentic-chat',
    parentMessageId: framingUserMessage.id,
    role: 'assistant',
    content:
      'That means the early turns should lock three things down: the exact file we care about, the official source of truth, and the shape of the final answer. After that, the tool trace will read naturally.',
    status: 'completed',
    createdAt: '2026-04-03T09:47:58.000Z',
    providerName: 'work',
    modelId: 'gpt-5'
  }
  const scopeUserMessage: MessageRecord = {
    id: 'demo-msg-agentic-user-setup-2',
    threadId: 'demo-thread-agentic-chat',
    role: 'user',
    content:
      'Keep it grounded. Use the official pricing page, call out the stale-docs problem directly, and do not let the assistant drift into product-marketing fluff.',
    status: 'completed',
    createdAt: '2026-04-03T09:48:20.000Z'
  }
  const scopeAssistantMessage: MessageRecord = {
    id: 'demo-msg-agentic-assistant-setup-2',
    threadId: 'demo-thread-agentic-chat',
    parentMessageId: scopeUserMessage.id,
    role: 'assistant',
    content:
      'Understood. I will keep it as plain product work: drift check first, live-source verification second, targeted file edit third, then a compact summary of the mismatch and the fix.',
    status: 'completed',
    createdAt: '2026-04-03T09:49:04.000Z',
    providerName: 'work',
    modelId: 'gpt-5'
  }
  const styleUserMessage: MessageRecord = {
    id: 'demo-msg-agentic-user-setup-3',
    threadId: 'demo-thread-agentic-chat',
    role: 'user',
    content:
      'And the close-out still needs to be readable. I want to understand the outcome without opening the diff viewer.',
    status: 'completed',
    createdAt: '2026-04-03T09:50:10.000Z'
  }
  const styleAssistantMessage: MessageRecord = {
    id: 'demo-msg-agentic-assistant-setup-3',
    threadId: 'demo-thread-agentic-chat',
    parentMessageId: styleUserMessage.id,
    role: 'assistant',
    content:
      'I will keep the internal work technical, but the final answer will stay plain: what I checked, what was out of date, and what I changed in the file.',
    status: 'completed',
    createdAt: '2026-04-03T09:50:48.000Z',
    providerName: 'work',
    modelId: 'gpt-5'
  }
  const prepUserMessage2: MessageRecord = {
    id: 'demo-msg-agentic-user-setup-4',
    threadId: 'demo-thread-agentic-chat',
    role: 'user',
    content:
      'If the live source and the docs disagree, spell that out. “Updated the docs” is not enough. I want the mismatch stated in one sentence.',
    status: 'completed',
    createdAt: '2026-04-03T09:51:24.000Z'
  }
  const prepAssistantMessage2: MessageRecord = {
    id: 'demo-msg-agentic-assistant-setup-4',
    threadId: 'demo-thread-agentic-chat',
    parentMessageId: prepUserMessage2.id,
    role: 'assistant',
    content:
      'I will make the mismatch explicit. The useful sentence here is “the official page now reflects the 3.1 Pro pricing table, while the local doc still carries 1.5-era launch framing.”',
    status: 'completed',
    createdAt: '2026-04-03T09:52:02.000Z',
    providerName: 'work',
    modelId: 'gpt-5'
  }
  const prepUserMessage: MessageRecord = {
    id: 'demo-msg-agentic-user-0',
    threadId: 'demo-thread-agentic-chat',
    role: 'user',
    content:
      'Before touching anything, compare how the docs talk about Gemini, OpenAI, and Anthropic so we know whether this is a one-file drift issue or a wider docs style problem.',
    status: 'completed',
    createdAt: '2026-04-03T09:54:10.000Z'
  }
  const prepAssistantMessage: MessageRecord = {
    id: 'demo-msg-agentic-assistant-0',
    threadId: 'demo-thread-agentic-chat',
    parentMessageId: prepUserMessage.id,
    role: 'assistant',
    content:
      'It looks isolated to Gemini. OpenAI and Anthropic already use a single “current pricing” section, while the Gemini doc still mixes current model naming with leftover launch-era framing, so that is the page worth fixing.',
    status: 'completed',
    createdAt: '2026-04-03T09:55:22.000Z',
    providerName: 'work',
    modelId: 'gpt-5'
  }
  const userMessage: MessageRecord = {
    id: 'demo-msg-agentic-user-1',
    threadId: 'demo-thread-agentic-chat',
    role: 'user',
    content:
      'Good. Pull the latest Gemini 3.1 Pro pricing from the official page, tell me what changed versus our doc, and update `docs/provider-pricing.md` if the numbers or framing drifted.',
    status: 'completed',
    createdAt: '2026-04-03T10:02:00.000Z',
    turnContext: {
      reminder: 'Prefer official pricing pages over blog posts or mirrors.',
      memoryEntries: [
        'The docs repo now keeps one current-pricing section per provider.',
        'This workspace uses README screenshots as product docs, so naming drift matters.'
      ]
    }
  }
  const assistantMessage: MessageRecord = {
    id: 'demo-msg-agentic-assistant-1',
    threadId: 'demo-thread-agentic-chat',
    parentMessageId: userMessage.id,
    role: 'assistant',
    content:
      'I checked the official Gemini pricing page and the drift was exactly what we expected: our doc still framed the section around the older 1.5-era launch language, while the live page now centers the 3.1 Pro table. I updated `docs/provider-pricing.md`, removed the stale comparison copy, and left a short note so the next check has a clean baseline.',
    status: 'completed',
    createdAt: '2026-04-03T10:04:20.000Z',
    providerName: 'work',
    modelId: 'gpt-5',
    reasoning:
      'Need an official source, then compare it to the existing doc text, then patch only the lines that drifted so the changelog stays readable.',
    responseMessages: [
      {
        role: 'assistant',
        content: [{ type: 'reasoning', text: 'Look for the vendor pricing page first.' }]
      },
      {
        role: 'tool',
        content: [
          { type: 'tool-result', toolName: 'webSearch', result: 'Official Gemini pricing page' }
        ]
      }
    ]
  }

  const thread = withThreadCapabilities({
    id: 'demo-thread-agentic-chat',
    icon: '🌐',
    title: 'Update pricing docs from live source',
    workspacePath: DEMO_WORKSPACE_PATH,
    preview: assistantMessage.content,
    updatedAt: assistantMessage.createdAt,
    rollingSummary:
      'Earlier turns compared provider docs and concluded Gemini was the only page still mixing current rates with historical launch-era copy.',
    summaryWatermarkMessageId: prepAssistantMessage.id,
    memoryRecall: {
      lastRunAt: assistantMessage.createdAt,
      lastRecallAt: userMessage.createdAt,
      lastRecallMessageCount: 16,
      lastRecallCharCount: 3780,
      recentInjections: [
        {
          memoryId: 'memory-docs-pricing-style',
          fingerprint: 'pricing-style-v2',
          injectedAt: userMessage.createdAt,
          messageCount: 2,
          charCount: 186,
          score: 0.87
        }
      ]
    }
  })

  storage.createThread({
    thread: withThreadCapabilities({
      ...thread,
      headMessageId: prepAssistantMessage.id
    }),
    createdAt: '2026-04-03T09:53:40.000Z',
    messages: [
      kickoffUserMessage,
      kickoffAssistantMessage,
      framingUserMessage,
      framingAssistantMessage,
      scopeUserMessage,
      scopeAssistantMessage,
      styleUserMessage,
      styleAssistantMessage,
      prepUserMessage2,
      prepAssistantMessage2,
      prepUserMessage,
      prepAssistantMessage
    ]
  })
  storage.startRun({
    runId: 'demo-run-agentic-chat-1',
    thread: withThreadCapabilities({
      ...thread,
      headMessageId: prepAssistantMessage.id
    }),
    updatedThread: withThreadCapabilities({
      ...thread,
      headMessageId: userMessage.id,
      preview: userMessage.content,
      updatedAt: userMessage.createdAt
    }),
    requestMessageId: userMessage.id,
    userMessage,
    createdAt: userMessage.createdAt
  })

  const toolCalls: ToolCallRecord[] = [
    {
      id: 'demo-tool-agentic-web-search',
      runId: 'demo-run-agentic-chat-1',
      threadId: thread.id,
      requestMessageId: userMessage.id,
      toolName: 'webSearch',
      status: 'completed',
      inputSummary: 'Search Gemini 3.1 Pro pricing',
      outputSummary: 'Found the official Gemini pricing page and two stale community summaries',
      startedAt: '2026-04-03T10:02:06.000Z',
      finishedAt: '2026-04-03T10:02:10.000Z',
      stepIndex: 1,
      stepBudget: 4,
      details: {
        provider: 'google-browser',
        query: 'Gemini 3.1 Pro pricing official',
        searchUrl: 'https://www.google.com/search?q=Gemini+3.1+Pro+pricing+official',
        finalUrl: 'https://www.google.com/search?q=Gemini+3.1+Pro+pricing+official',
        resultCount: 3,
        results: [
          {
            rank: 1,
            title: 'Gemini API pricing',
            url: 'https://ai.google.dev/gemini-api/docs/pricing',
            snippet: 'Official model pricing for Gemini 3.1 Pro and related families.'
          },
          {
            rank: 2,
            title: 'Gemini launch recap',
            url: 'https://developers.googleblog.com/gemini-launch-recap',
            snippet: 'Launch-era announcement without current rates.'
          },
          {
            rank: 3,
            title: 'Community model matrix',
            url: 'https://example.dev/model-matrix',
            snippet: 'Aggregated pricing table with stale 1.5 references.'
          }
        ]
      }
    },
    {
      id: 'demo-tool-agentic-web-read',
      runId: 'demo-run-agentic-chat-1',
      threadId: thread.id,
      requestMessageId: userMessage.id,
      toolName: 'webRead',
      status: 'completed',
      inputSummary: 'Read the official Gemini pricing document',
      outputSummary: 'Captured the current Gemini 3.1 Pro pricing table as markdown',
      startedAt: '2026-04-03T10:02:11.000Z',
      finishedAt: '2026-04-03T10:02:18.000Z',
      stepIndex: 2,
      stepBudget: 4,
      details: {
        requestedUrl: 'https://ai.google.dev/gemini-api/docs/pricing',
        finalUrl: 'https://ai.google.dev/gemini-api/docs/pricing',
        httpStatus: 200,
        contentType: 'text/html; charset=utf-8',
        extractor: 'defuddle',
        title: 'Gemini API pricing',
        siteName: 'Google AI for Developers',
        publishedTime: '2026-03-28T00:00:00.000Z',
        description: 'Official pricing for current Gemini API models.',
        content:
          '# Gemini API pricing\n\n## Gemini 3.1 Pro\n- Input: current live rate\n- Output: current live rate\n- Context caching supported\n',
        contentFormat: 'markdown',
        contentChars: 123,
        originalContentChars: 2910,
        truncated: false,
        savedFileName: 'gemini-pricing.md',
        savedFilePath: `${DEMO_WORKSPACE_PATH}/tmp/gemini-pricing.md`,
        savedBytes: 123
      }
    },
    {
      id: 'demo-tool-agentic-read-doc',
      runId: 'demo-run-agentic-chat-1',
      threadId: thread.id,
      requestMessageId: userMessage.id,
      toolName: 'read',
      status: 'completed',
      inputSummary: 'Read the existing provider pricing doc',
      outputSummary: 'Located the stale 1.5-era comparison copy around the Gemini section',
      startedAt: '2026-04-03T10:02:18.000Z',
      finishedAt: '2026-04-03T10:02:19.000Z',
      stepIndex: 3,
      stepBudget: 4,
      details: {
        path: DEMO_PRICING_DOC_PATH,
        startLine: 38,
        endLine: 92,
        totalLines: 118,
        totalBytes: 4872,
        truncated: false
      }
    },
    {
      id: 'demo-tool-agentic-edit',
      runId: 'demo-run-agentic-chat-1',
      threadId: thread.id,
      requestMessageId: userMessage.id,
      toolName: 'edit',
      status: 'completed',
      inputSummary: 'Patch `docs/provider-pricing.md`',
      outputSummary: 'Replaced stale launch copy with the current Gemini 3.1 Pro reference block',
      startedAt: '2026-04-03T10:02:19.000Z',
      finishedAt: '2026-04-03T10:02:25.000Z',
      stepIndex: 4,
      stepBudget: 4,
      details: {
        path: DEMO_PRICING_DOC_PATH,
        replacements: 2,
        firstChangedLine: 47,
        diff: `- Gemini pricing still references the 1.5-era launch table.\n+ Gemini pricing now points at the current 3.1 Pro table.\n- Historical launch notes are mixed into the current pricing section.\n+ Historical launch notes were moved into a short changelog note.`
      }
    }
  ]

  for (const toolCall of toolCalls) {
    storage.createToolCall(toolCall)
  }

  storage.completeRun({
    runId: 'demo-run-agentic-chat-1',
    updatedThread: withThreadCapabilities({
      ...thread,
      headMessageId: assistantMessage.id
    }),
    assistantMessage,
    promptTokens: 1820,
    completionTokens: 348,
    totalPromptTokens: 2160,
    totalCompletionTokens: 348
  })

  return withThreadCapabilities({
    ...thread,
    headMessageId: assistantMessage.id
  })
}

function createSidebarThreads(storage: YachiyoStorage): void {
  const threads: Array<{
    id: string
    title: string
    preview: string
    updatedAt: string
    createdAt: string
    icon?: string
    starredAt?: string
    privacyMode?: boolean
    workspacePath?: string
  }> = [
    {
      id: 'demo-thread-sidebar-1',
      title: 'Triage onboarding copy',
      preview: 'Shortlist the three lines that should survive into the first-run tooltip.',
      updatedAt: '2026-04-03T10:13:10.000Z',
      createdAt: '2026-04-03T10:12:40.000Z',
      icon: '✦',
      starredAt: '2026-04-03T10:13:11.000Z',
      workspacePath: DEMO_WORKSPACE_PATH
    },
    {
      id: 'demo-thread-sidebar-2',
      title: 'Summarize Discord feedback',
      preview:
        'Group the launch-war-room feedback into bugs, copy issues, and screenshot requests.',
      updatedAt: '2026-04-03T10:06:40.000Z',
      createdAt: '2026-04-03T10:06:00.000Z',
      icon: '💬',
      workspacePath: DEMO_WORKSPACE_PATH
    },
    {
      id: 'demo-thread-sidebar-3',
      title: 'Check screenshot crop list',
      preview:
        'The README only needs two captures now: the long agent thread and the ACP coding review.',
      updatedAt: '2026-04-03T10:00:50.000Z',
      createdAt: '2026-04-03T10:00:10.000Z',
      icon: '🖼️',
      workspacePath: DEMO_WORKSPACE_PATH
    },
    {
      id: 'demo-thread-sidebar-4',
      title: 'Draft release tweet variants',
      preview:
        'Keep one neutral version, one technical version, and one friendlier launch-day variant.',
      updatedAt: '2026-04-03T09:58:12.000Z',
      createdAt: '2026-04-03T09:57:40.000Z',
      icon: '📝',
      workspacePath: DEMO_WORKSPACE_PATH
    },
    {
      id: 'demo-thread-sidebar-5',
      title: 'Review model picker wording',
      preview: 'Hide disabled models by default and tighten the copy around enabled choices.',
      updatedAt: '2026-04-03T09:51:36.000Z',
      createdAt: '2026-04-03T09:50:58.000Z',
      icon: '🤖',
      workspacePath: DEMO_WORKSPACE_PATH
    },
    {
      id: 'demo-thread-sidebar-6',
      title: 'Private launch checklist',
      preview:
        'Internal only: final screenshot order, changelog timing, and release-thread handoff.',
      updatedAt: '2026-04-03T09:47:54.000Z',
      createdAt: '2026-04-03T09:47:20.000Z',
      icon: '🔒',
      privacyMode: true,
      workspacePath: DEMO_WORKSPACE_PATH
    }
  ]

  for (const entry of threads) {
    const userMessage: MessageRecord = {
      id: `${entry.id}-user-1`,
      threadId: entry.id,
      role: 'user',
      content: entry.preview,
      status: 'completed',
      createdAt: entry.createdAt
    }
    const assistantMessage: MessageRecord = {
      id: `${entry.id}-assistant-1`,
      threadId: entry.id,
      parentMessageId: userMessage.id,
      role: 'assistant',
      content: entry.preview,
      status: 'completed',
      createdAt: entry.updatedAt,
      providerName: 'work',
      modelId: 'gpt-5-mini'
    }

    storage.createThread({
      thread: withThreadCapabilities({
        id: entry.id,
        title: entry.title,
        preview: entry.preview,
        updatedAt: entry.updatedAt,
        headMessageId: assistantMessage.id,
        ...(entry.icon ? { icon: entry.icon } : {}),
        ...(entry.starredAt ? { starredAt: entry.starredAt } : {}),
        ...(entry.privacyMode ? { privacyMode: true } : {}),
        ...(entry.workspacePath ? { workspacePath: entry.workspacePath } : {})
      }),
      createdAt: entry.createdAt,
      messages: [userMessage, assistantMessage]
    })
  }
}

function createCodingDispatchThread(storage: YachiyoStorage): ThreadRecord {
  const planningUserMessage: MessageRecord = {
    id: 'demo-msg-dispatch-user-0',
    threadId: 'demo-thread-coding-dispatch',
    role: 'user',
    content: 'We need a safe auth review. Please split proposal work from verification work.',
    status: 'completed',
    createdAt: '2026-04-03T10:07:18.000Z'
  }
  const planningAssistantMessage: MessageRecord = {
    id: 'demo-msg-dispatch-assistant-0',
    threadId: 'demo-thread-coding-dispatch',
    parentMessageId: planningUserMessage.id,
    role: 'assistant',
    content:
      'I will send the design review to Claude Code, then hand the failure-mode pass to Codex so the final answer comes back here as one summary.',
    status: 'completed',
    createdAt: '2026-04-03T10:07:30.000Z',
    providerName: 'work',
    modelId: 'gpt-5'
  }
  const userMessage: MessageRecord = {
    id: 'demo-msg-dispatch-user-1',
    threadId: 'demo-thread-coding-dispatch',
    role: 'user',
    content:
      'Ask Claude Code to review `src/auth.ts` and propose a safer token refresh flow. Then have Codex verify edge cases and summarize the result here.',
    status: 'completed',
    createdAt: '2026-04-03T10:09:10.000Z',
    turnContext: {
      memoryEntries: [
        'Avoid hidden retries in auth flows.',
        'Refresh-token failure should move the app into an explicit signed-out state.'
      ]
    }
  }
  const assistantMessage: MessageRecord = {
    id: 'demo-msg-dispatch-assistant-1',
    threadId: 'demo-thread-coding-dispatch',
    parentMessageId: userMessage.id,
    role: 'assistant',
    content:
      'Both reviews are back. Claude Code proposed a guarded refresh path with explicit retry limits, a single in-flight refresh lock, and a clear invalid-session exit. Codex stress-checked the overlap cases around expired refresh tokens and concurrent refresh attempts, and the proposal holds. I merged both results into one patch-ready summary for `src/auth.ts`.',
    status: 'completed',
    createdAt: '2026-04-03T10:11:40.000Z',
    providerName: 'work',
    modelId: 'gpt-5',
    reasoning:
      'Dispatch architecture review first, then send the design to a second agent for adversarial verification before writing the summary.'
  }

  const thread = withThreadCapabilities({
    id: 'demo-thread-coding-dispatch',
    icon: '🧪',
    title: 'Delegate auth review to coding agents',
    workspacePath: DEMO_WORKSPACE_PATH,
    preview: assistantMessage.content,
    updatedAt: assistantMessage.createdAt,
    runtimeBinding: {
      kind: 'acp',
      profileId: 'claude-code-default',
      profileName: 'Claude Code',
      sessionId: 'session_demo_auth_review',
      sessionStatus: 'active',
      lastSessionBoundAt: '2026-04-03T10:10:45.000Z'
    },
    lastDelegatedSession: {
      agentName: 'Codex',
      sessionId: 'session_demo_codex_auth_review',
      workspacePath: DEMO_WORKSPACE_PATH,
      timestamp: '2026-04-03T10:10:58.000Z'
    },
    rollingSummary:
      'This workspace uses delegated ACP sessions for coding tasks. Claude Code handles primary implementation proposals, then Codex verifies edge cases before the merged answer returns here.',
    summaryWatermarkMessageId: planningAssistantMessage.id
  })

  storage.createThread({
    thread: withThreadCapabilities({
      ...thread,
      headMessageId: planningAssistantMessage.id
    }),
    createdAt: '2026-04-03T10:06:58.000Z',
    messages: [planningUserMessage, planningAssistantMessage]
  })
  storage.startRun({
    runId: 'demo-run-coding-dispatch-1',
    thread: withThreadCapabilities({
      ...thread,
      headMessageId: planningAssistantMessage.id
    }),
    updatedThread: withThreadCapabilities({
      ...thread,
      headMessageId: userMessage.id,
      preview: userMessage.content,
      updatedAt: userMessage.createdAt
    }),
    requestMessageId: userMessage.id,
    userMessage,
    createdAt: userMessage.createdAt
  })

  const toolCalls: ToolCallRecord[] = [
    {
      id: 'demo-tool-dispatch-claude',
      runId: 'demo-run-coding-dispatch-1',
      threadId: thread.id,
      requestMessageId: userMessage.id,
      toolName: 'delegateCodingTask',
      status: 'completed',
      inputSummary: 'Ask Claude Code to review `src/auth.ts`',
      outputSummary:
        'Proposed guarded retries, a single refresh lock, and explicit invalid-session handling',
      startedAt: '2026-04-03T10:09:22.000Z',
      finishedAt: '2026-04-03T10:10:08.000Z',
      stepIndex: 1,
      stepBudget: 3
    },
    {
      id: 'demo-tool-dispatch-codex',
      runId: 'demo-run-coding-dispatch-1',
      threadId: thread.id,
      requestMessageId: userMessage.id,
      toolName: 'delegateCodingTask',
      status: 'completed',
      inputSummary: 'Ask Codex to verify refresh edge cases',
      outputSummary:
        'Confirmed the revised flow handles expired tokens and overlapping refresh attempts cleanly',
      startedAt: '2026-04-03T10:09:24.000Z',
      finishedAt: '2026-04-03T10:10:32.000Z',
      stepIndex: 2,
      stepBudget: 3
    },
    {
      id: 'demo-tool-dispatch-bash',
      runId: 'demo-run-coding-dispatch-1',
      threadId: thread.id,
      requestMessageId: userMessage.id,
      toolName: 'bash',
      status: 'completed',
      inputSummary: 'Run focused auth tests',
      outputSummary: 'Auth refresh tests passed after the proposed lock and retry changes',
      cwd: DEMO_WORKSPACE_PATH,
      startedAt: '2026-04-03T10:10:40.000Z',
      finishedAt: '2026-04-03T10:11:05.000Z',
      stepIndex: 3,
      stepBudget: 3,
      details: {
        command: 'pnpm test src/auth.test.ts',
        cwd: DEMO_WORKSPACE_PATH,
        exitCode: 0,
        stdout:
          'TAP version 13\n# auth refresh serializes concurrent refresh requests\nok 1 - serializes refresh requests\n# auth refresh signs out after invalid refresh token\nok 2 - signs out on invalid refresh token',
        stderr: ''
      }
    }
  ]

  for (const toolCall of toolCalls) {
    storage.createToolCall(toolCall)
  }

  storage.completeRun({
    runId: 'demo-run-coding-dispatch-1',
    updatedThread: withThreadCapabilities({
      ...thread,
      headMessageId: assistantMessage.id
    }),
    assistantMessage,
    promptTokens: 1914,
    completionTokens: 352,
    totalPromptTokens: 2438,
    totalCompletionTokens: 352
  })

  return withThreadCapabilities({
    ...thread,
    headMessageId: assistantMessage.id
  })
}

function createReplyBranchingThread(storage: YachiyoStorage): ThreadRecord {
  const rootMessage: MessageRecord = {
    id: 'demo-msg-branch-user-1',
    threadId: 'demo-thread-reply-branching',
    role: 'user',
    content: 'Write release notes for this update in a concise tone.',
    status: 'completed',
    createdAt: '2026-04-03T10:15:00.000Z'
  }
  const conciseReply: MessageRecord = {
    id: 'demo-msg-branch-assistant-1a',
    threadId: 'demo-thread-reply-branching',
    parentMessageId: rootMessage.id,
    role: 'assistant',
    content:
      'Added a dev-only demo mode, refreshed the seeded threads, and kept production behavior unchanged.',
    status: 'completed',
    createdAt: '2026-04-03T10:15:24.000Z',
    providerName: 'work',
    modelId: 'gpt-5'
  }
  const technicalReply: MessageRecord = {
    id: 'demo-msg-branch-assistant-1b',
    threadId: 'demo-thread-reply-branching',
    parentMessageId: rootMessage.id,
    role: 'assistant',
    content:
      'Added a development-only demo mode backed by richer in-memory storage, refreshed the screenshot threads and schedule history, and left the production runtime untouched.',
    status: 'completed',
    createdAt: '2026-04-03T10:15:37.000Z',
    providerName: 'work',
    modelId: 'gpt-5'
  }
  const followUp: MessageRecord = {
    id: 'demo-msg-branch-user-2',
    threadId: 'demo-thread-reply-branching',
    parentMessageId: technicalReply.id,
    role: 'user',
    content: 'Make it more friendly.',
    status: 'completed',
    createdAt: '2026-04-03T10:17:02.000Z'
  }
  const selectedReply: MessageRecord = {
    id: 'demo-msg-branch-assistant-2',
    threadId: 'demo-thread-reply-branching',
    parentMessageId: followUp.id,
    role: 'assistant',
    content:
      'Added a clean demo mode for screenshots, made the sample threads much richer, and left the real app behavior exactly as it was.',
    status: 'completed',
    createdAt: '2026-04-03T10:18:08.000Z',
    providerName: 'work',
    modelId: 'gpt-5'
  }
  const queuedFollowUp: MessageRecord = {
    id: 'demo-msg-branch-user-3',
    threadId: 'demo-thread-reply-branching',
    parentMessageId: selectedReply.id,
    role: 'user',
    content:
      'Before you polish the final README copy, ask me whether the tone should stay technical or become more friendly.',
    status: 'completed',
    createdAt: '2026-04-03T10:18:46.000Z',
    turnContext: {
      reminder: 'Keep the public-facing language grounded in shipped features.',
      memoryEntries: [
        'Leader prefers literal release copy over exaggerated marketing phrasing.',
        'README screenshots should highlight branching and tool traces.'
      ]
    }
  }
  const completedReply: MessageRecord = {
    id: 'demo-msg-branch-assistant-3',
    threadId: 'demo-thread-reply-branching',
    parentMessageId: queuedFollowUp.id,
    role: 'assistant',
    content:
      'Finished. I kept the final README line friendly and direct, stayed away from launch-hype wording, and left the release note in the same plainspoken tone so the screenshot reads cleanly.',
    status: 'completed',
    createdAt: '2026-04-03T10:19:34.000Z',
    providerName: 'work',
    modelId: 'gpt-5-mini'
  }

  const initialThread = withThreadCapabilities({
    id: 'demo-thread-reply-branching',
    icon: '🌿',
    title: 'Choose release note tone',
    workspacePath: DEMO_WORKSPACE_PATH,
    preview: selectedReply.content,
    updatedAt: selectedReply.createdAt,
    headMessageId: selectedReply.id
  })
  const completedThread = withThreadCapabilities({
    ...initialThread,
    preview: completedReply.content,
    updatedAt: completedReply.createdAt,
    headMessageId: completedReply.id,
    createdFromEssentialId: 'launch-ops',
    modelOverride: {
      providerName: 'work',
      model: 'gpt-5-mini'
    },
    rollingSummary:
      'This thread demonstrates reply branching: one concise branch, one technical branch, and a later request to reframe the release note for screenshots and README copy.',
    summaryWatermarkMessageId: selectedReply.id
  })

  storage.createThread({
    thread: initialThread,
    createdAt: '2026-04-03T10:14:40.000Z',
    messages: [rootMessage, conciseReply, technicalReply, followUp, selectedReply]
  })
  storage.startRun({
    runId: 'demo-run-branch-tone-1',
    thread: initialThread,
    updatedThread: withThreadCapabilities({
      ...completedThread,
      preview: queuedFollowUp.content,
      updatedAt: queuedFollowUp.createdAt,
      headMessageId: queuedFollowUp.id
    }),
    requestMessageId: queuedFollowUp.id,
    userMessage: queuedFollowUp,
    createdAt: queuedFollowUp.createdAt
  })

  const toolCalls: ToolCallRecord[] = [
    {
      id: 'demo-tool-branch-skills-read',
      runId: 'demo-run-branch-tone-1',
      threadId: completedThread.id,
      requestMessageId: queuedFollowUp.id,
      toolName: 'skillsRead',
      status: 'completed',
      inputSummary: 'Load the `frontend-design` skill before rewriting release copy',
      outputSummary: 'Loaded the design guidance for concise product-facing copy',
      startedAt: '2026-04-03T10:18:47.000Z',
      finishedAt: '2026-04-03T10:18:48.000Z',
      stepIndex: 1,
      stepBudget: 3,
      details: {
        requestedNames: ['frontend-design'],
        resolvedCount: 1,
        skills: [
          {
            name: 'frontend-design',
            directoryPath: '/Users/demo/.codex/skills/frontend-design',
            skillFilePath: '/Users/demo/.codex/skills/frontend-design/SKILL.md',
            description: 'Create distinctive, production-grade frontend interfaces.'
          }
        ]
      }
    },
    {
      id: 'demo-tool-branch-read-brief',
      runId: 'demo-run-branch-tone-1',
      threadId: completedThread.id,
      requestMessageId: queuedFollowUp.id,
      toolName: 'read',
      status: 'completed',
      inputSummary: 'Re-open the launch brief and screenshot notes',
      outputSummary:
        'Confirmed the README still needs the friendlier copy pass for the hero caption',
      startedAt: '2026-04-03T10:18:48.000Z',
      finishedAt: '2026-04-03T10:18:49.000Z',
      stepIndex: 2,
      stepBudget: 3,
      details: {
        path: DEMO_BRIEF_PATH,
        startLine: 1,
        endLine: 44,
        totalLines: 44,
        totalBytes: 1860,
        truncated: false
      }
    },
    {
      id: 'demo-tool-branch-edit-copy',
      runId: 'demo-run-branch-tone-1',
      threadId: completedThread.id,
      requestMessageId: queuedFollowUp.id,
      toolName: 'edit',
      status: 'completed',
      inputSummary: 'Polish the final README and release-note copy',
      outputSummary: 'Shifted the final line into a friendlier tone without changing the substance',
      startedAt: '2026-04-03T10:18:52.000Z',
      finishedAt: '2026-04-03T10:18:58.000Z',
      stepIndex: 3,
      stepBudget: 3,
      details: {
        path: DEMO_BRIEF_PATH,
        replacements: 1,
        firstChangedLine: 18,
        diff: `- Added a development-only demo mode backed by richer in-memory storage.\n+ Added a clean demo mode with richer sample threads and a friendlier README line.`
      }
    }
  ]

  for (const toolCall of toolCalls) {
    storage.createToolCall(toolCall)
  }

  storage.completeRun({
    runId: 'demo-run-branch-tone-1',
    updatedThread: completedThread,
    assistantMessage: completedReply,
    promptTokens: 822,
    completionTokens: 124,
    totalPromptTokens: 1120,
    totalCompletionTokens: 124
  })

  return completedThread
}

function createArchivedHandoffThread(storage: YachiyoStorage): ThreadRecord {
  const userMessage: MessageRecord = {
    id: 'demo-msg-archive-user-1',
    threadId: 'demo-thread-archived-handoff',
    role: 'user',
    content:
      'Summarize the launch-ops handoff and archive this thread once the checklist is stable.',
    status: 'completed',
    createdAt: '2026-04-02T18:02:10.000Z'
  }
  const assistantMessage: MessageRecord = {
    id: 'demo-msg-archive-assistant-1',
    threadId: 'demo-thread-archived-handoff',
    parentMessageId: userMessage.id,
    role: 'assistant',
    content:
      'Handoff complete. Remaining work is limited to final screenshot capture, one headline tone choice, and the release-tweet timing check.',
    status: 'completed',
    createdAt: '2026-04-02T18:05:40.000Z',
    providerName: 'work',
    modelId: 'gpt-5'
  }

  const thread = withThreadCapabilities({
    id: 'demo-thread-archived-handoff',
    title: 'Archive launch ops handoff',
    workspacePath: DEMO_WORKSPACE_PATH,
    preview: assistantMessage.content,
    updatedAt: assistantMessage.createdAt,
    headMessageId: assistantMessage.id,
    privacyMode: true,
    starredAt: '2026-04-02T18:06:00.000Z',
    rollingSummary:
      'Archived handoff thread: screenshot plan is stable, docs are synced, and only launch-day publishing choices remain.',
    summaryWatermarkMessageId: assistantMessage.id
  })

  storage.createThread({
    thread,
    createdAt: '2026-04-02T18:00:00.000Z',
    messages: [userMessage, assistantMessage]
  })
  storage.archiveThread({
    threadId: thread.id,
    archivedAt: '2026-04-02T18:07:10.000Z',
    updatedAt: '2026-04-02T18:07:10.000Z',
    readAt: '2026-04-03T08:00:00.000Z'
  })

  return withThreadCapabilities({
    ...thread,
    archivedAt: '2026-04-02T18:07:10.000Z',
    updatedAt: '2026-04-02T18:07:10.000Z'
  })
}

function createSchedules(
  storage: YachiyoStorage,
  input: { agenticThreadId: string; dispatchThreadId: string; branchingThreadId: string }
): void {
  const schedules: ScheduleRecord[] = [
    {
      id: 'demo-schedule-daily-docs-sync',
      name: 'Daily docs sync',
      cronExpression: '0 9 * * *',
      prompt:
        'Refresh documentation notes, verify provider pricing references, and leave a short summary for the docs thread.',
      workspacePath: DEMO_WORKSPACE_PATH,
      enabled: false,
      createdAt: '2026-04-02T09:00:00.000Z',
      updatedAt: '2026-04-03T09:52:00.000Z'
    },
    {
      id: 'demo-schedule-weekly-release-checklist',
      name: 'Weekly release checklist',
      cronExpression: '30 9 * * 1',
      prompt:
        'Review the release checklist, confirm the README captures are current, and summarize anything still blocked.',
      workspacePath: DEMO_WORKSPACE_PATH,
      enabled: false,
      createdAt: '2026-04-02T09:10:00.000Z',
      updatedAt: '2026-04-03T09:44:00.000Z'
    },
    {
      id: 'demo-schedule-provider-pricing-check',
      name: 'Provider pricing check',
      runAt: '2026-04-03T09:20:00.000Z',
      prompt:
        'Check the current provider pricing page, update the docs if numbers changed, and record the result for README screenshots.',
      workspacePath: DEMO_WORKSPACE_PATH,
      enabled: false,
      createdAt: '2026-04-02T09:20:00.000Z',
      updatedAt: '2026-04-03T09:26:00.000Z'
    }
  ]

  for (const schedule of schedules) {
    storage.createSchedule(schedule)
  }

  const runs: ScheduleRunRecord[] = [
    {
      id: 'demo-schedule-run-6',
      scheduleId: 'demo-schedule-weekly-release-checklist',
      threadId: input.branchingThreadId,
      status: 'completed',
      resultStatus: 'failure',
      resultSummary:
        'Release checklist paused because the final README headline tone still needs a user decision before the screenshot pass can be closed.',
      promptTokens: 860,
      completionTokens: 118,
      startedAt: '2026-04-03T10:25:12.000Z',
      completedAt: '2026-04-03T10:25:46.000Z'
    },
    {
      id: 'demo-schedule-run-5',
      scheduleId: 'demo-schedule-daily-docs-sync',
      threadId: input.agenticThreadId,
      status: 'completed',
      resultStatus: 'success',
      resultSummary:
        'README screenshots and pricing notes stayed aligned after the latest docs sync.',
      promptTokens: 1180,
      completionTokens: 240,
      startedAt: '2026-04-03T09:52:10.000Z',
      completedAt: '2026-04-03T09:53:01.000Z'
    },
    {
      id: 'demo-schedule-run-4',
      scheduleId: 'demo-schedule-weekly-release-checklist',
      threadId: input.dispatchThreadId,
      status: 'completed',
      resultStatus: 'success',
      resultSummary:
        'Release checklist reviewed; auth demo screenshots and the coding-dispatch thread are ready for README capture.',
      promptTokens: 944,
      completionTokens: 112,
      startedAt: '2026-04-03T09:44:18.000Z',
      completedAt: '2026-04-03T09:45:04.000Z'
    },
    {
      id: 'demo-schedule-run-3',
      scheduleId: 'demo-schedule-provider-pricing-check',
      status: 'completed',
      resultStatus: 'success',
      resultSummary:
        'Provider pricing check completed and README screenshots now use the current 2026 model names.',
      promptTokens: 702,
      completionTokens: 180,
      startedAt: '2026-04-03T09:20:00.000Z',
      completedAt: '2026-04-03T09:20:37.000Z'
    },
    {
      id: 'demo-schedule-run-2',
      scheduleId: 'demo-schedule-weekly-release-checklist',
      threadId: input.branchingThreadId,
      status: 'completed',
      resultStatus: 'success',
      resultSummary:
        'Release-note branches remained aligned with the screenshot brief, and the branch examples are ready for demo capture.',
      promptTokens: 816,
      completionTokens: 96,
      startedAt: '2026-04-03T03:26:12.000Z',
      completedAt: '2026-04-03T03:26:40.000Z'
    },
    {
      id: 'demo-schedule-run-1',
      scheduleId: 'demo-schedule-daily-docs-sync',
      threadId: input.agenticThreadId,
      status: 'completed',
      resultStatus: 'success',
      resultSummary: 'README screenshots stayed aligned after the last demo-data polish pass.',
      promptTokens: 1086,
      completionTokens: 226,
      startedAt: '2026-04-03T03:52:10.000Z',
      completedAt: '2026-04-03T03:52:48.000Z'
    }
  ]

  for (const run of runs) {
    storage.createScheduleRun({
      id: run.id,
      scheduleId: run.scheduleId,
      status: 'running',
      startedAt: run.startedAt
    })
    storage.completeScheduleRun({
      id: run.id,
      status: run.status,
      ...(run.threadId ? { threadId: run.threadId } : {}),
      ...(run.resultStatus ? { resultStatus: run.resultStatus } : {}),
      ...(run.resultSummary ? { resultSummary: run.resultSummary } : {}),
      ...(run.error ? { error: run.error } : {}),
      ...(run.promptTokens != null ? { promptTokens: run.promptTokens } : {}),
      ...(run.completionTokens != null ? { completionTokens: run.completionTokens } : {}),
      completedAt: run.completedAt!
    })
  }
}
