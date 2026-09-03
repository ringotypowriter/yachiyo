/**
 * Reading and writing one thread: which slice of it to read, and the plan
 * document attached to it.
 */

export interface LoadThreadDataInput {
  threadId: string
  /** Omit or set true to read messages; false skips them for a metadata-only refresh. */
  includeMessages?: boolean
  /**
   * Read at most this many messages, newest first, instead of the whole thread.
   *
   * Omitting it reads everything, and callers that push a thread's full state
   * to the UI depend on that: a page would silently drop the older half.
   */
  limit?: number
  /** Read messages older than this one, for walking backwards through a thread. */
  beforeMessageId?: string
}

export interface SaveThreadInput {
  threadId: string
  archiveAfterSave?: boolean
}

export interface ReadThreadPlanDocumentInput {
  threadId: string
}

export interface ReadThreadPlanDocumentResult {
  path: string
  content: string
  decision?: 'pending' | 'rejected' | 'accepted'
}

export type AcceptThreadPlanDocumentMode = 'direct' | 'handoff'

export interface AcceptThreadPlanDocumentInput {
  threadId: string
  mode?: AcceptThreadPlanDocumentMode
}
