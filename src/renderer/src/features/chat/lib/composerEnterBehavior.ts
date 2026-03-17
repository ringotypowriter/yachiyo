const IME_PROCESSING_KEY_CODE = 229

export type ComposerEnterEvent = {
  key: string
  shiftKey: boolean
  isComposing: boolean
  keyCode?: number
}

export function shouldSendOnComposerEnter(event: ComposerEnterEvent): boolean {
  if (event.key !== 'Enter' || event.shiftKey) {
    return false
  }

  if (event.isComposing) {
    return false
  }

  if (event.keyCode === IME_PROCESSING_KEY_CODE) {
    return false
  }

  return true
}
