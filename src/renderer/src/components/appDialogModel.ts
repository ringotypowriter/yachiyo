export type DialogActionTone = 'default' | 'accent' | 'danger'

export interface DialogActionModel {
  key: string
  tone?: DialogActionTone
  autoFocus?: boolean
  disabled?: boolean
}

export interface DialogSubmitKeyEvent {
  key: string
  metaKey?: boolean
  ctrlKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
  isComposing?: boolean
  keyCode?: number
}

export interface DialogSubmitTarget {
  tagName?: string
  type?: string
  isContentEditable?: boolean
}

export function getDefaultDialogActionKey(actions: readonly DialogActionModel[]): string | null {
  const enabledActions = actions.filter((action) => !action.disabled)
  return (
    enabledActions.find((action) => action.autoFocus)?.key ??
    enabledActions.find((action) => action.tone === 'accent')?.key ??
    enabledActions.find((action) => action.tone === 'danger')?.key ??
    enabledActions[0]?.key ??
    null
  )
}

export function shouldSubmitDialogAction(
  event: DialogSubmitKeyEvent,
  target?: DialogSubmitTarget | null
): boolean {
  if (event.key !== 'Enter') return false
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return false
  if (event.isComposing || event.keyCode === 229) return false
  if (!target) return true
  if (target.isContentEditable) return false

  const tagName = target.tagName?.toLowerCase()
  if (tagName === 'textarea') return false
  if (tagName === 'button' || tagName === 'a' || tagName === 'select') return false
  if (tagName === 'input') {
    const type = target.type?.toLowerCase() ?? 'text'
    return (
      type === 'email' ||
      type === 'number' ||
      type === 'password' ||
      type === 'search' ||
      type === 'tel' ||
      type === 'text' ||
      type === 'url'
    )
  }
  return true
}
