interface PredictionKeyEvent {
  key: string
  shiftKey: boolean
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  isComposing: boolean
  keyCode: number
}

export function resolvePredictionKey(
  event: PredictionKeyEvent,
  selectionStart: number,
  selectionEnd: number,
  valueLength: number
): 'accept' | 'dismiss' | null {
  if (valueLength !== 0) return null
  if (event.isComposing || event.keyCode === 229) return null
  if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return null
  if (event.key === 'Escape') return 'dismiss'
  if (selectionStart !== valueLength || selectionEnd !== valueLength) return null
  return event.key === 'Tab' || event.key === 'ArrowRight' ? 'accept' : null
}
