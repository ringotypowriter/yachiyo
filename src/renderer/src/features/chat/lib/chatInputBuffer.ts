import type {
  MessageImageRecord,
  SendChatAttachment
} from '../../../../../shared/yachiyo/protocol.ts'

// Initial wait matches the extend wait so Chinese/Japanese IME users have
// enough time to compose and commit their first segment before the buffer
// locks in. 3s felt rushed during IME composition.
export const CHAT_INPUT_BUFFER_INITIAL_WAIT_MS = 5000
export const CHAT_INPUT_BUFFER_EXTEND_WAIT_MS = 5000

export interface ChatInputBufferPayload {
  // Thread the payload was composed for. Captured at stage time and used by
  // every downstream operation (flush, thread-switch merge, failure restore)
  // so buffered content is never delivered into — or restored into — a
  // thread other than the one the user was typing in.
  sourceThreadId: string
  content: string
  images: MessageImageRecord[]
  attachments: SendChatAttachment[]
  enabledSkillNames: string[] | null | undefined
}

export interface ChatInputBufferState {
  staged: ChatInputBufferPayload | null
  flushAt: number | null
  waitMs: number | null
}

export const EMPTY_CHAT_INPUT_BUFFER_STATE: ChatInputBufferState = {
  staged: null,
  flushAt: null,
  waitMs: null
}

function mergeContent(previous: string, next: string): string {
  if (previous.length === 0) return next
  if (next.length === 0) return previous
  return `${previous}\n${next}`
}

export function stageChatInputBuffer(
  state: ChatInputBufferState,
  payload: ChatInputBufferPayload,
  nowMs: number
): ChatInputBufferState {
  if (!state.staged) {
    return {
      staged: payload,
      flushAt: nowMs + CHAT_INPUT_BUFFER_INITIAL_WAIT_MS,
      waitMs: CHAT_INPUT_BUFFER_INITIAL_WAIT_MS
    }
  }

  const merged: ChatInputBufferPayload = {
    // Keep the original source thread. Staging across threads is blocked
    // upstream, so a mismatch would be a caller bug — refuse to mix content
    // by sticking with the first-staged thread.
    sourceThreadId: state.staged.sourceThreadId,
    content: mergeContent(state.staged.content, payload.content),
    images: [...state.staged.images, ...payload.images],
    attachments: [...state.staged.attachments, ...payload.attachments],
    enabledSkillNames:
      payload.enabledSkillNames !== undefined
        ? payload.enabledSkillNames
        : state.staged.enabledSkillNames
  }

  return {
    staged: merged,
    flushAt: nowMs + CHAT_INPUT_BUFFER_EXTEND_WAIT_MS,
    waitMs: CHAT_INPUT_BUFFER_EXTEND_WAIT_MS
  }
}

export function clearChatInputBuffer(): ChatInputBufferState {
  return EMPTY_CHAT_INPUT_BUFFER_STATE
}

export function getChatInputBufferProgress(state: ChatInputBufferState, nowMs: number): number {
  if (!state.staged || state.flushAt === null || state.waitMs === null) return 0
  const remaining = state.flushAt - nowMs
  if (remaining <= 0) return 1
  if (remaining >= state.waitMs) return 0
  return 1 - remaining / state.waitMs
}
