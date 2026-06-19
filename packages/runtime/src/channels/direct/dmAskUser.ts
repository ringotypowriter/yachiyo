import type {
  AskUserToolCallDetails,
  ToolCallRecord,
  YachiyoServerEvent
} from '@yachiyo/shared/protocol'

/**
 * A DM run paused on an `askUser` tool call, parked until the channel user
 * replies (or the TTL expires). Keyed by channelUserId in {@link DmAskUserStore}.
 */
export interface DmAskUserPending {
  threadId: string
  runId: string
  toolCallId: string
  choices?: string[]
}

interface DmAskUserEntry extends DmAskUserPending {
  timeout: ReturnType<typeof setTimeout>
  onExpire?: () => void | Promise<void>
}

export interface DmAskUserStore {
  get(channelUserId: string): DmAskUserPending | null
  set(channelUserId: string, pending: DmAskUserPending, onExpire?: () => void | Promise<void>): void
  delete(channelUserId: string): void
}

export interface DmAskUserStoreOptions {
  ttlMs?: number
  onExpireError?(error: unknown): void
}

const ASK_USER_TTL_MS = 5 * 60 * 1000
const NUMBER_ONLY_MESSAGE = /^\d+$/

/** Answer fed to the waiting tool when the user never replies within the TTL. */
export const DM_ASK_USER_TIMEOUT_ANSWER =
  '(The user did not respond in time. Continue with your best judgment or wrap up.)'

/** Notice sent to the DM when a question times out without an answer. */
export const DM_ASK_USER_TIMEOUT_NOTICE = 'No response — continuing without an answer.'

function toPending(entry: DmAskUserEntry): DmAskUserPending {
  return {
    threadId: entry.threadId,
    runId: entry.runId,
    toolCallId: entry.toolCallId,
    ...(entry.choices ? { choices: entry.choices } : {})
  }
}

export function createDmAskUserStore(options: DmAskUserStoreOptions = {}): DmAskUserStore {
  const ttlMs = options.ttlMs ?? ASK_USER_TTL_MS
  const onExpireError =
    options.onExpireError ??
    ((error: unknown): void => {
      console.error('[dmAskUser] expiry handler failed', error)
    })
  const entries = new Map<string, DmAskUserEntry>()

  const remove = (channelUserId: string): void => {
    const entry = entries.get(channelUserId)
    if (!entry) {
      return
    }
    clearTimeout(entry.timeout)
    entries.delete(channelUserId)
  }

  return {
    get(channelUserId) {
      const entry = entries.get(channelUserId)
      return entry ? toPending(entry) : null
    },
    set(channelUserId, pending, onExpire) {
      remove(channelUserId)
      const timeout = setTimeout(() => {
        const entry = entries.get(channelUserId)
        if (!entry || entry.timeout !== timeout) {
          return
        }
        entries.delete(channelUserId)
        if (entry.onExpire) {
          void Promise.resolve(entry.onExpire()).catch(onExpireError)
        }
      }, ttlMs)
      entries.set(channelUserId, { ...pending, timeout, onExpire })
    },
    delete(channelUserId) {
      remove(channelUserId)
    }
  }
}

/** Render an askUser question for a text channel: question plus numbered choices. */
export function formatAskUserQuestion(question: string, choices?: string[]): string {
  if (!choices || choices.length === 0) {
    return question
  }
  const lines = [question, '']
  choices.forEach((choice, index) => {
    lines.push(`${index + 1}. ${choice}`)
  })
  lines.push('', 'Reply with a number, or type your answer.')
  return lines.join('\n')
}

/**
 * Map a user's plain-text reply to an answer string. A bare number selects the
 * matching choice; anything else is passed through as a free-form answer.
 */
export function resolveAskUserAnswer(pending: DmAskUserPending, text: string): string {
  const trimmed = text.trim()
  const { choices } = pending
  if (choices && choices.length > 0 && NUMBER_ONLY_MESSAGE.test(trimmed)) {
    const index = Number(trimmed) - 1
    if (Number.isSafeInteger(index) && index >= 0 && index < choices.length) {
      return choices[index]
    }
  }
  return trimmed
}

function extractAskUserDetails(toolCall: ToolCallRecord): AskUserToolCallDetails | null {
  const details = toolCall.details
  return details && 'kind' in details && details.kind === 'askUser' ? details : null
}

export interface WatchDmAskUserQuestionsOptions {
  subscribe(listener: (event: YachiyoServerEvent) => void): () => void
  store: DmAskUserStore
  channelUserId: string
  threadId: string
  runId: string
  /** Deliver the formatted question to the user (ordered with other outbound text). */
  sendQuestion(text: string): Promise<void>
  /** Resolve the waiting tool — used when the question times out. */
  answerToolQuestion(input: { runId: string; toolCallId: string; answer: string }): void
  /** Notify the user that the run moved on without their answer. */
  sendTimeoutNotice(text: string): Promise<void>
  onError?(error: unknown): void
}

/**
 * Bridges runtime `askUser` tool calls to a DM channel: when a run for this
 * thread pauses on an askUser question, the question is delivered to the user
 * and parked in the store so the user's next message can answer it. Returns an
 * unsubscribe function. Each question (toolCallId) is delivered at most once.
 */
export function watchDmAskUserQuestions(options: WatchDmAskUserQuestionsOptions): () => void {
  const delivered = new Set<string>()
  const onError =
    options.onError ??
    ((error: unknown): void => {
      console.error('[dmAskUser] failed to deliver question', error)
    })

  return options.subscribe((event: YachiyoServerEvent) => {
    if (event.type !== 'tool.updated' || event.threadId !== options.threadId) {
      return
    }
    const toolCall = event.toolCall
    if (toolCall.runId !== options.runId || toolCall.status !== 'waiting-for-user') {
      return
    }
    const details = extractAskUserDetails(toolCall)
    if (!details || delivered.has(toolCall.id)) {
      return
    }
    delivered.add(toolCall.id)

    const pending: DmAskUserPending = {
      threadId: options.threadId,
      runId: options.runId,
      toolCallId: toolCall.id,
      ...(details.choices ? { choices: details.choices } : {})
    }

    options.store.set(options.channelUserId, pending, async () => {
      options.answerToolQuestion({
        runId: pending.runId,
        toolCallId: pending.toolCallId,
        answer: DM_ASK_USER_TIMEOUT_ANSWER
      })
      await options.sendTimeoutNotice(DM_ASK_USER_TIMEOUT_NOTICE)
    })

    void options
      .sendQuestion(formatAskUserQuestion(details.question, details.choices))
      .catch((error: unknown) => {
        options.store.delete(options.channelUserId)
        onError(error)
      })
  })
}
