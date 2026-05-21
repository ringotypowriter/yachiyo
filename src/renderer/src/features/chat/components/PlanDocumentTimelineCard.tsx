import React, { memo } from 'react'
import type { PlanDocumentState } from '@renderer/app/store/useAppStore'
import type { InlineCodeFileLinkSnapshot } from '@renderer/lib/markdown/inlineCodeFileLinkSnapshot'
import { theme } from '@renderer/theme/theme'
import type { AcceptThreadPlanDocumentMode } from '../../../../../shared/yachiyo/protocol.ts'
import { PlanDocumentCard } from './PlanDocumentCard'

interface PlanDocumentTimelineCardProps {
  planDocument: PlanDocumentState | null
  threadId: string | null
  inlineCodeFileLinks: InlineCodeFileLinkSnapshot
  onAcceptPlanDocument: (threadId: string, mode: AcceptThreadPlanDocumentMode) => Promise<void>
  onRejectPlanDocument: (threadId: string) => Promise<void>
}

export const PlanDocumentTimelineCard = memo(function PlanDocumentTimelineCard({
  planDocument,
  threadId,
  inlineCodeFileLinks,
  onAcceptPlanDocument,
  onRejectPlanDocument
}: PlanDocumentTimelineCardProps): React.JSX.Element | null {
  if (!planDocument) return null

  if (planDocument.decision === 'rejected') {
    return (
      <div className="px-6 py-1">
        <div
          className="text-[11px]"
          style={{
            color: theme.text.muted,
            background: theme.background.surfaceMuted,
            border: `1px solid ${theme.border.subtle}`,
            borderRadius: 10,
            padding: '8px 10px'
          }}
        >
          Plan rejected. Send revision notes to continue.
        </div>
      </div>
    )
  }

  const decision = planDocument.decision ?? 'pending'

  return (
    <PlanDocumentCard
      path={planDocument.path}
      content={planDocument.content}
      decision={decision}
      defaultExpanded={decision !== 'accepted'}
      inlineCodeFileLinks={inlineCodeFileLinks}
      onAcceptDirect={
        threadId
          ? () => {
              void onAcceptPlanDocument(threadId, 'direct')
            }
          : undefined
      }
      onAcceptHandoff={
        threadId
          ? () => {
              void onAcceptPlanDocument(threadId, 'handoff')
            }
          : undefined
      }
      onReject={
        threadId
          ? () => {
              void onRejectPlanDocument(threadId)
            }
          : undefined
      }
    />
  )
})
