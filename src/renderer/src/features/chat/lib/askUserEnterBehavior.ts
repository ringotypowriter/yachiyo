const IME_PROCESSING_KEY_CODE = 229

export type AskUserEnterEvent = {
  key: string
  shiftKey: boolean
  isComposing: boolean
  keyCode?: number
}

export function shouldSubmitAskUserAnswer(event: AskUserEnterEvent): boolean {
  if (event.key !== 'Enter' || event.shiftKey) {
    return false
  }

  if (event.isComposing) {
    return false
  }

  return event.keyCode !== IME_PROCESSING_KEY_CODE
}
