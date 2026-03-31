// keyCode 229 is the IME processing sentinel — fired on some browsers/platforms
// when a key event is still being handled by the input method.
const IME_PROCESSING_KEY_CODE = 229

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
    if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === IME_PROCESSING_KEY_CODE) return
    if (e.key === 'Enter') {
      e.preventDefault()
      handler()
    }
  }
}
