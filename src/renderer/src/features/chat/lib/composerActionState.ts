import type { ConnectionStatus } from '@renderer/app/types'

export function getComposerActionState(input: {
  connectionStatus: ConnectionStatus
  hasActiveRun: boolean
  hasFailedImages: boolean
  hasLoadingImages: boolean
  hasPayload: boolean
  isConfigured: boolean
  threadIsSaving?: boolean
}): {
  canSend: boolean
  showStopButton: boolean
} {
  const showStopButton = input.hasActiveRun
  const canSend =
    !input.threadIsSaving &&
    input.hasPayload &&
    !input.hasLoadingImages &&
    !input.hasFailedImages &&
    input.isConfigured &&
    input.connectionStatus === 'connected'

  return {
    canSend,
    showStopButton
  }
}
