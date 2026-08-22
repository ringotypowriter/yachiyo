export type ComposerStopTarget = 'parent' | 'workers' | 'none'

export interface ComposerStopTargetInput {
  hasActiveRun: boolean
  threadId: string | null
  runningWorkerCount: number
}

export interface ComposerCancelOperation {
  operationId: number
  threadId: string
  promise: Promise<void>
}

export function resolveComposerStopTarget(input: ComposerStopTargetInput): ComposerStopTarget {
  if (input.hasActiveRun) return 'parent'
  if (input.threadId && input.runningWorkerCount > 0) return 'workers'
  return 'none'
}

export function isComposerCancelInFlightForThread(
  operation: ComposerCancelOperation | null,
  threadId: string | null
): boolean {
  return operation !== null && threadId !== null && operation.threadId === threadId
}

export function settleComposerCancelOperation(
  operation: ComposerCancelOperation | null,
  operationId: number
): ComposerCancelOperation | null {
  return operation?.operationId === operationId ? null : operation
}
