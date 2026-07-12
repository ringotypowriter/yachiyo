import type React from 'react'
import { ChevronLeft, ChevronRight, GitBranch } from 'lucide-react'
import { useT } from '@yachiyo/i18n/react'

interface ReplyBranchNavigationProps {
  canSelectNextReply: boolean
  canSelectPreviousReply: boolean
  onSelectNextReply?: () => Promise<void> | void
  onSelectPreviousReply?: () => Promise<void> | void
  replyCount: number
}

export function ReplyBranchNavigation({
  canSelectNextReply,
  canSelectPreviousReply,
  onSelectNextReply,
  onSelectPreviousReply,
  replyCount
}: ReplyBranchNavigationProps): React.JSX.Element {
  const t = useT()
  return (
    <div className="assistant-message-bubble__branch-nav">
      <span className="assistant-message-bubble__branch-nav-icon" aria-hidden="true">
        <GitBranch size={11} strokeWidth={1.8} />
      </span>
      <span>{t('chat.timeline.replyCount', { count: replyCount })}</span>
      <div className="assistant-message-bubble__branch-nav-actions">
        <button
          type="button"
          className="assistant-message-bubble__branch-nav-button"
          onClick={() => void onSelectPreviousReply?.()}
          aria-label={t('chat.timeline.previousReplyAria')}
          disabled={!canSelectPreviousReply}
        >
          <ChevronLeft size={13} strokeWidth={1.7} />
        </button>
        <button
          type="button"
          className="assistant-message-bubble__branch-nav-button"
          onClick={() => void onSelectNextReply?.()}
          aria-label={t('chat.timeline.nextReplyAria')}
          disabled={!canSelectNextReply}
        >
          <ChevronRight size={13} strokeWidth={1.7} />
        </button>
      </div>
    </div>
  )
}
