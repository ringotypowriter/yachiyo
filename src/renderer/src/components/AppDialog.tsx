import React, { useCallback, useEffect, useMemo, useRef } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { theme, alpha } from '@renderer/theme/theme'
import { useRestoreFocusOnUnmount } from '@renderer/lib/focusRestore'
import { isDismissEscapeKey } from '@renderer/lib/imeUtils'
import {
  getDefaultDialogActionKey,
  shouldSubmitDialogAction,
  type DialogActionModel,
  type DialogActionTone
} from './appDialogModel'

export type AppDialogActionTone = DialogActionTone

export interface AppDialogAction extends DialogActionModel {
  label: string
  icon?: React.ReactNode
}

export interface AppDialogProps {
  title?: React.ReactNode
  description?: React.ReactNode
  children?: React.ReactNode
  actions?: AppDialogAction[]
  actionsLayout?: 'vertical' | 'horizontal'
  onAction?: (key: string) => void
  onClose: () => void
  closeOnBackdrop?: boolean
  showCloseButton?: boolean
  width?: number | string
  minWidth?: number | string
  maxWidth?: number | string
  height?: number | string
  maxHeight?: number | string
  zIndex?: number
  bodyPadding?: number | string
  bodyStyle?: React.CSSProperties
  panelStyle?: React.CSSProperties
  ariaLabel?: string
  initialFocus?: 'default-action' | 'first'
}

const focusableSelector = [
  'button:not(:disabled)',
  '[href]',
  'input:not(:disabled)',
  'select:not(:disabled)',
  'textarea:not(:disabled)',
  '[tabindex]:not([tabindex="-1"])'
].join(',')

function getFocusableElements(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(focusableSelector)).filter(
    (element) => element.offsetParent !== null || element === document.activeElement
  )
}

function actionBackground(tone: AppDialogActionTone | undefined): string {
  if (tone === 'accent') return theme.text.accent
  if (tone === 'danger') return alpha('danger', 0.08)
  return alpha('ink', 0.06)
}

function actionColor(tone: AppDialogActionTone | undefined): string {
  if (tone === 'accent') return theme.text.inverse
  if (tone === 'danger') return theme.text.dangerStrong
  return theme.text.primary
}

export function AppDialog({
  title,
  description,
  children,
  actions = [],
  actionsLayout = 'vertical',
  onAction,
  onClose,
  closeOnBackdrop = true,
  showCloseButton = false,
  width = 340,
  minWidth,
  maxWidth = 'calc(100vw - 32px)',
  height,
  maxHeight = 'calc(100vh - 32px)',
  zIndex = 200,
  bodyPadding = 20,
  bodyStyle,
  panelStyle,
  ariaLabel,
  initialFocus = 'default-action'
}: AppDialogProps): React.JSX.Element {
  const panelRef = useRef<HTMLDivElement>(null)
  const defaultActionKey = useMemo(() => getDefaultDialogActionKey(actions), [actions])

  useRestoreFocusOnUnmount()

  const invokeAction = useCallback(
    (key: string): void => {
      const action = actions.find((entry) => entry.key === key)
      if (!action || action.disabled) return
      onAction?.(key)
    },
    [actions, onAction]
  )

  useEffect(() => {
    const panel = panelRef.current
    if (!panel) return
    const target =
      (initialFocus === 'default-action'
        ? panel.querySelector<HTMLElement>('[data-dialog-default-action="true"]')
        : null) ??
      getFocusableElements(panel)[0] ??
      panel
    target.focus({ preventScroll: true })
  }, [initialFocus])

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    if (isDismissEscapeKey(event.nativeEvent)) {
      event.preventDefault()
      event.stopPropagation()
      onClose()
      return
    }

    if (event.key === 'Tab') {
      const panel = panelRef.current
      if (!panel) return
      const focusable = getFocusableElements(panel)
      if (focusable.length === 0) {
        event.preventDefault()
        panel.focus({ preventScroll: true })
        return
      }

      const activeIndex = focusable.indexOf(document.activeElement as HTMLElement)
      const nextIndex = event.shiftKey
        ? activeIndex <= 0
          ? focusable.length - 1
          : activeIndex - 1
        : activeIndex === focusable.length - 1
          ? 0
          : activeIndex + 1
      event.preventDefault()
      focusable[nextIndex].focus({ preventScroll: true })
      return
    }

    if (
      defaultActionKey &&
      shouldSubmitDialogAction(event.nativeEvent, event.target as HTMLElement)
    ) {
      event.preventDefault()
      event.stopPropagation()
      invokeAction(defaultActionKey)
    }
  }

  const hasHeader = title != null || showCloseButton
  const hasBody = children != null

  return createPortal(
    <div
      className="fixed inset-0 flex items-center justify-center"
      style={{
        zIndex,
        background: 'rgba(0, 0, 0, 0.25)',
        padding: 16
      }}
      onMouseDown={() => {
        if (closeOnBackdrop) onClose()
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel ?? (typeof title === 'string' ? title : undefined)}
        tabIndex={-1}
        className="flex flex-col"
        style={{
          width,
          minWidth,
          maxWidth,
          height,
          maxHeight,
          overflow: 'hidden',
          background: theme.background.surfaceFrosted,
          backdropFilter: 'blur(24px)',
          WebkitBackdropFilter: 'blur(24px)',
          border: `1px solid ${theme.border.strong}`,
          borderRadius: 16,
          boxShadow: theme.shadow.menu,
          outline: 'none',
          ...panelStyle
        }}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        {hasHeader ? (
          <div
            className="flex items-start justify-between gap-4 shrink-0 px-5 pt-4 pb-3"
            style={{ borderBottom: hasBody ? `1px solid ${theme.border.subtle}` : undefined }}
          >
            <div className="min-w-0">
              {title != null ? (
                <div
                  className="text-sm font-medium"
                  style={{ color: theme.text.primary, lineHeight: 1.45 }}
                >
                  {title}
                </div>
              ) : null}
              {description != null ? (
                <div className="text-xs mt-1" style={{ color: theme.text.muted, lineHeight: 1.55 }}>
                  {description}
                </div>
              ) : null}
            </div>
            {showCloseButton ? (
              <button
                type="button"
                onClick={onClose}
                className="p-1 rounded-md transition-opacity opacity-40 hover:opacity-70 shrink-0"
                style={{
                  color: theme.icon.default,
                  border: 'none',
                  background: 'none',
                  cursor: 'default'
                }}
                aria-label="Close"
              >
                <X size={14} strokeWidth={2} />
              </button>
            ) : null}
          </div>
        ) : null}

        {hasBody ? (
          <div
            className="min-h-0 flex-1"
            style={{
              padding: bodyPadding,
              overflowY: 'auto',
              ...bodyStyle
            }}
          >
            {children}
          </div>
        ) : null}

        {actions.length > 0 ? (
          <div
            className={
              actionsLayout === 'horizontal'
                ? 'shrink-0 px-5 py-3 flex justify-end gap-2'
                : 'shrink-0 px-5 pb-5 flex flex-col gap-1.5'
            }
            style={{
              borderTop:
                hasBody && actionsLayout === 'horizontal'
                  ? `1px solid ${theme.border.subtle}`
                  : undefined
            }}
          >
            {actions.map((action) => {
              const isDefault = action.key === defaultActionKey
              return (
                <button
                  key={action.key}
                  type="button"
                  disabled={action.disabled}
                  data-dialog-default-action={isDefault ? 'true' : undefined}
                  onClick={() => invokeAction(action.key)}
                  className={
                    actionsLayout === 'horizontal'
                      ? 'inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-opacity hover:opacity-80'
                      : 'inline-flex items-center justify-center gap-2 w-full rounded-xl px-4 py-2 text-sm font-medium transition-opacity hover:opacity-80'
                  }
                  style={{
                    border: 'none',
                    cursor: action.disabled ? 'not-allowed' : 'default',
                    opacity: action.disabled ? 0.5 : 1,
                    background: actionBackground(action.tone),
                    color: actionColor(action.tone)
                  }}
                >
                  {action.icon}
                  {action.label}
                </button>
              )
            })}
          </div>
        ) : null}
      </div>
    </div>,
    document.body
  )
}
