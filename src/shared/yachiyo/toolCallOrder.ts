interface ToolCallChronology {
  id: string
  startedAt: string
  stepIndex?: number
}

export function compareToolCallsChronologically<T extends ToolCallChronology>(
  left: T,
  right: T
): number {
  const startedAtDifference = left.startedAt.localeCompare(right.startedAt)
  if (startedAtDifference !== 0) {
    return startedAtDifference
  }

  const leftHasStepIndex = typeof left.stepIndex === 'number'
  const rightHasStepIndex = typeof right.stepIndex === 'number'
  if (leftHasStepIndex && rightHasStepIndex) {
    const leftStepIndex = left.stepIndex as number
    const rightStepIndex = right.stepIndex as number
    if (leftStepIndex !== rightStepIndex) {
      return leftStepIndex - rightStepIndex
    }
  }

  if (leftHasStepIndex !== rightHasStepIndex) {
    return leftHasStepIndex ? -1 : 1
  }

  return 0
}

export function sortToolCallsChronologically<T extends ToolCallChronology>(toolCalls: T[]): T[] {
  return [...toolCalls].sort(compareToolCallsChronologically)
}
