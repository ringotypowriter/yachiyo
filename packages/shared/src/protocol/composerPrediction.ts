export interface ComposerPredictionInput {
  sessionId: string
  /** Omit the thread to cancel the pending prediction for this composer. */
  threadId?: string
}
