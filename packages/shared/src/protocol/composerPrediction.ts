export interface ComposerPredictionInput {
  sessionId: string
  /** Empty text cancels the pending prediction for this composer. */
  text: string
}
