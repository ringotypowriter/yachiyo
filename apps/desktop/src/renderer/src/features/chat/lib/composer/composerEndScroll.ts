type Scrollport = Pick<HTMLElement, 'scrollHeight' | 'clientHeight' | 'scrollTop'>

export function shouldSyncComposerEndScroll(
  value: string,
  layoutValue: string | undefined,
  lastScrolledValue: string | null
): boolean {
  return layoutValue === value && lastScrolledValue !== value
}

/** Keep the visible final line in view after the overlay has committed its new text. */
export function syncComposerEndScroll(textarea: Scrollport, overlay: Scrollport | null): void {
  if (
    textarea.scrollHeight <= textarea.clientHeight + 3 &&
    (!overlay || overlay.scrollHeight <= overlay.clientHeight + 3)
  )
    return

  textarea.scrollTop = textarea.scrollHeight - textarea.clientHeight
  if (overlay)
    overlay.scrollTop = Math.max(textarea.scrollTop, overlay.scrollHeight - overlay.clientHeight)
}

export function resolveComposerCaretOverlayScrollTop({
  previous,
  textareaTop,
  caretBottom,
  viewportHeight,
  contentHeight,
  atEnd
}: {
  previous: number
  textareaTop: number
  caretBottom: number
  viewportHeight: number
  contentHeight: number
  atEnd: boolean
}): number {
  let next = atEnd && previous > textareaTop ? previous : textareaTop
  if (caretBottom > next + viewportHeight)
    next = Math.min(caretBottom - viewportHeight, Math.max(0, contentHeight - viewportHeight))
  return next
}
