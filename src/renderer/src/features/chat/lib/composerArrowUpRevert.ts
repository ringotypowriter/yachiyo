export function shouldRevertPendingComposerMessagesOnArrowUp(input: {
  key: string
  metaKey: boolean
  altKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  hasPayload: boolean
  hasPendingSteer: boolean
  hasQueuedFollowUp: boolean
}): boolean {
  return (
    input.key === 'ArrowUp' &&
    !input.metaKey &&
    !input.altKey &&
    !input.ctrlKey &&
    !input.shiftKey &&
    !input.hasPayload &&
    (input.hasPendingSteer || input.hasQueuedFollowUp)
  )
}
