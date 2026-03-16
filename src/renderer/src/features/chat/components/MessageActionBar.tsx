import type React from 'react'
import { useEffect, useState } from 'react'
import { Check, Copy, GitBranchPlus, RotateCcw, Trash2 } from 'lucide-react'
import { copyTextWithFallback } from '../lib/copyTextWithFallback'

interface MessageActionBarProps {
  align?: 'start' | 'end'
  content: string
  canRetry?: boolean
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
        color: success ? '#4f8a6b' : danger ? '#9b4638' : '#6d6962'
      }}
      title={label}
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
  onRetry,
  onCreateBranch,
  onDelete
}: MessageActionBarProps): React.JSX.Element {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')

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
      <ActionButton
        icon={
          copyState === 'copied' ? (
            <Check size={12} strokeWidth={2} />
          ) : (
            <Copy size={12} strokeWidth={1.7} />
          )
        }
        label={copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Copy failed' : 'Copy'}
        success={copyState === 'copied'}
        onClick={handleCopy}
      />
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
