import { hasExactPrimaryShortcutModifiers } from '../../../../lib/platformShortcut.ts'

interface ShortcutEvent {
  altKey: boolean
  code?: string
  ctrlKey: boolean
  key: string
  metaKey: boolean
  shiftKey: boolean
}

interface PlainTextPasteInput {
  currentValue: string
  pastedText: string
  selectionEnd: number
  selectionStart: number
}

interface PlainTextPasteResult {
  caretOffset: number
  value: string
}

export function isPastePlainTextShortcut(event: ShortcutEvent, platform: string): boolean {
  return (
    hasExactPrimaryShortcutModifiers(event, platform, true) &&
    (event.code === 'KeyV' || event.key.toLowerCase() === 'v')
  )
}

export function buildPlainTextPasteValue(input: PlainTextPasteInput): PlainTextPasteResult {
  const value =
    input.currentValue.slice(0, input.selectionStart) +
    input.pastedText +
    input.currentValue.slice(input.selectionEnd)

  return {
    caretOffset: input.selectionStart + input.pastedText.length,
    value
  }
}
