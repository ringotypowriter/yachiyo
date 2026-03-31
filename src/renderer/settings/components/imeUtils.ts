/**
 * Wraps an onChange handler to skip events fired during IME composition.
 * Use this on every <input> and <textarea> that updates state on change,
 * so that intermediate composition characters don't land as real values.
 */
export function imeSafeChange(
  handler: (value: string) => void
): (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => void {
  return (e) => {
    if ((e.nativeEvent as InputEvent).isComposing) return
    handler(e.target.value)
  }
}
