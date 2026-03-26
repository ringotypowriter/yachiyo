import type React from 'react'
import { useEffect, useState } from 'react'
import { Check, Copy, GitBranchPlus, Pencil, RotateCcw, Trash2 } from 'lucide-react'
import { theme } from '@renderer/theme/theme'
import { copyTextWithFallback } from '../lib/copyTextWithFallback'

interface MessageActionBarProps {
  align?: 'start' | 'end'
  content: string
  canRetry?: boolean
  onEdit?: () => void
  onRetry?: () => Promise<void> | void
  onCreateBranch?: () => Promise<void> | void
  onDelete?: () => Promise<void> | void
}

function ActionButton({
  icon,
  label,
  danger = false,
  success = false,
  disabled = false,
  onClick
}: {
  icon: React.ReactNode
  label: string
  danger?: boolean
  success?: boolean
  disabled?: boolean
  onClick: () => Promise<void> | void
}): React.JSX.Element {
  return (
    <button
      onClick={() => void onClick()}
      className="message-action-button"
      aria-label={label}
      disabled={disabled}
      style={{
        color: success ? theme.text.success : danger ? theme.text.dangerStrong : theme.text.tertiary
      }}
      type="button"
    >
      <span className="message-action-button__icon">{icon}</span>
    </button>
  )
}

export function MessageActionBar({
  align = 'end',
  content,
  canRetry = false,
  onEdit,
  onRetry,
  onCreateBranch,
  onDelete
}: MessageActionBarProps): React.JSX.Element {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const canCopy = content.trim().length > 0

  useEffect(() => {
    if (copyState === 'idle') {
      return
    }

    const timer = window.setTimeout(() => {
      setCopyState('idle')
    }, 1400)

    return () => {
      window.clearTimeout(timer)
    }
  }, [copyState])

  async function handleCopy(): Promise<void> {
    try {
      await copyTextWithFallback(content)
      setCopyState('copied')
    } catch {
      setCopyState('failed')
    }
  }

  return (
    <div
      className={`message-actions${align === 'start' ? ' message-actions--start' : ''}`}
      role="toolbar"
      aria-label="Message actions"
    >
      {canCopy ? (
        <ActionButton
          icon={
            copyState === 'copied' ? (
              <Check size={12} strokeWidth={2} />
            ) : (
              <Copy size={12} strokeWidth={1.7} />
            )
          }
          label={
            copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Copy failed' : 'Copy'
          }
          success={copyState === 'copied'}
          onClick={handleCopy}
        />
      ) : null}
      {onEdit ? (
        <ActionButton icon={<Pencil size={12} strokeWidth={1.7} />} label="Edit" onClick={onEdit} />
      ) : null}
      {onRetry ? (
        <ActionButton
          icon={<RotateCcw size={12} strokeWidth={1.7} />}
          label="Retry"
          disabled={!canRetry}
          onClick={onRetry}
        />
      ) : null}
      {onCreateBranch ? (
        <ActionButton
          icon={<GitBranchPlus size={12} strokeWidth={1.7} />}
          label="Branch"
          onClick={onCreateBranch}
        />
      ) : null}
      {onDelete ? (
        <ActionButton
          icon={<Trash2 size={12} strokeWidth={1.7} />}
          label="Delete from here"
          danger
          onClick={onDelete}
        />
      ) : null}
    </div>
  )
}
