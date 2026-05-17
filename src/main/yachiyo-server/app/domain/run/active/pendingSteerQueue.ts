import type { PendingSteerInput, RunState } from '../runTypes.ts'

function isHiddenSteer(input: PendingSteerInput): boolean {
  return input.hidden === true
}

function orderedPendingSteerInputs(inputs: PendingSteerInput[]): PendingSteerInput[] {
  const hidden = inputs.filter(isHiddenSteer)
  const visible = inputs.filter((input) => !isHiddenSteer(input))
  return [...hidden, ...visible]
}

function mergePendingSteerInput(
  existing: PendingSteerInput,
  input: PendingSteerInput
): PendingSteerInput {
  return {
    ...existing,
    content: [existing.content, input.content].filter((part) => part.length > 0).join('\n'),
    images: [...(existing.images ?? []), ...(input.images ?? [])],
    attachments: [...existing.attachments, ...input.attachments],
    enabledSkillNames: input.enabledSkillNames,
    reasoningEffort: input.reasoningEffort ?? existing.reasoningEffort,
    runTrigger: input.runTrigger ?? existing.runTrigger
  }
}

export function getPendingSteerInputs(runState: RunState): PendingSteerInput[] {
  return runState.pendingSteerInputs ?? []
}

export function hasPendingSteerInputs(runState: RunState): boolean {
  return getPendingSteerInputs(runState).length > 0
}

export function addPendingSteerInput(runState: RunState, input: PendingSteerInput): void {
  const inputs = getPendingSteerInputs(runState)
  const existingIndex = inputs.findIndex(
    (existing) => isHiddenSteer(existing) === isHiddenSteer(input)
  )
  const nextInputs =
    existingIndex >= 0
      ? inputs.map((existing, index) =>
          index === existingIndex ? mergePendingSteerInput(existing, input) : existing
        )
      : [...inputs, input]

  runState.pendingSteerInputs = orderedPendingSteerInputs(nextInputs)
}

export function getPendingSteerInputsForPersistence(runState: RunState): PendingSteerInput[] {
  return orderedPendingSteerInputs(getPendingSteerInputs(runState))
}

export function getFinalPendingSteerInput(runState: RunState): PendingSteerInput | undefined {
  return getPendingSteerInputsForPersistence(runState).at(-1)
}

export function applyFinalPendingSteerOptions(runState: RunState): void {
  const finalSteer = getFinalPendingSteerInput(runState)
  if (!finalSteer) {
    return
  }

  runState.enabledSkillNames = finalSteer.enabledSkillNames
    ? [...finalSteer.enabledSkillNames]
    : undefined

  if (finalSteer.reasoningEffort !== undefined) {
    runState.reasoningEffort = finalSteer.reasoningEffort
  } else if (finalSteer.previousReasoningEffort !== undefined) {
    runState.reasoningEffort = finalSteer.previousReasoningEffort
  } else {
    delete runState.reasoningEffort
  }

  if (finalSteer.runTrigger !== undefined) {
    runState.runTrigger = finalSteer.runTrigger
  } else if (finalSteer.previousRunTrigger !== undefined) {
    runState.runTrigger = finalSteer.previousRunTrigger
  } else {
    delete runState.runTrigger
  }
}

export function clearPendingSteerInputs(runState: RunState): void {
  delete runState.pendingSteerInputs
  delete runState.pendingSteerMessageId
}

export function removeVisiblePendingSteerInputs(runState: RunState): PendingSteerInput | undefined {
  const inputs = getPendingSteerInputs(runState)
  const visible = inputs.find((input) => !isHiddenSteer(input))
  if (!visible) {
    return undefined
  }

  const remaining = inputs.filter(isHiddenSteer)
  if (remaining.length > 0) {
    runState.pendingSteerInputs = remaining
  } else {
    clearPendingSteerInputs(runState)
  }
  return visible
}
