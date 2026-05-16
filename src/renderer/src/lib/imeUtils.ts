// keyCode 229 is the IME processing sentinel — fired on some browsers/platforms
// when a key event is still being handled by the input method.
const IME_PROCESSING_KEY_CODE = 229

function isImeComposingKeyEvent(event: Pick<KeyboardEvent, 'isComposing' | 'keyCode'>): boolean {
  return event.isComposing || event.keyCode === IME_PROCESSING_KEY_CODE
}

export function isDismissEscapeKey(
  event: Pick<KeyboardEvent, 'isComposing' | 'key' | 'keyCode'>
): boolean {
  return event.key === 'Escape' && !isImeComposingKeyEvent(event)
}

/**
 * Wraps an Enter key handler with IME composition guard.
 * Skips the action when the key event is part of IME composition,
 * preventing premature submission of half-composed characters.
 * Matches the same guard used in the chat composer (isComposing + keyCode 229).
 */
export function imeSafeEnter(
  handler: () => void
): (e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => void {
  return (e) => {
    if (isImeComposingKeyEvent(e.nativeEvent)) return
    if (e.key === 'Enter') {
      e.preventDefault()
      handler()
    }
  }
}
