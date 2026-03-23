import type React from 'react'
import { useId, useState } from 'react'
import { Brain, ChevronRight } from 'lucide-react'
import type { RecallDecisionSnapshot } from '@renderer/app/types'
import { theme } from '@renderer/theme/theme'

interface RunMemoryRecallRowProps {
  entries: string[]
  recallDecision?: RecallDecisionSnapshot
}

function compactNovelTerms(terms: string[] | undefined): string[] {
  if (!terms || terms.length === 0) {
    return []
  }

  const seen = new Set<string>()
  const compacted: string[] = []

  for (const term of terms) {
    const normalized = term.trim()
    if (!normalized || seen.has(normalized)) {
      continue
    }

    seen.add(normalized)
    compacted.push(normalized.length > 24 ? `${normalized.slice(0, 24).trimEnd()}...` : normalized)

    if (compacted.length >= 3) {
      break
    }
  }

  return compacted
}

function formatReason(reason: string): string {
  switch (reason) {
    case 'thread-cold-start':
      return 'new thread'
    case 'message-growth':
      return 'message growth'
    case 'char-growth':
      return 'context growth'
    case 'idle-gap':
      return 'idle gap'
    case 'topic-novelty':
      return 'new topic'
    case 'recall-failed':
      return 'recall failed'
    default:
      return reason
  }
}

export function RunMemoryRecallRow({
  entries,
  recallDecision
}: RunMemoryRecallRowProps): React.JSX.Element {
  const [isExpanded, setIsExpanded] = useState(false)
  const detailsId = useId()
  const reasons = recallDecision?.reasons?.map(formatReason) ?? []
  const debugLabel = reasons.length > 0 ? reasons.join(', ') : 'manual/unknown'
  const shouldShowNovelTerms = recallDecision?.reasons?.includes('topic-novelty') ?? false
  const novelTerms = shouldShowNovelTerms ? compactNovelTerms(recallDecision?.novelTerms) : []

  return (
    <div className="px-6 pb-1">
      <button
        type="button"
        className="inline-flex items-center gap-1.5 text-left"
        aria-controls={detailsId}
        aria-expanded={isExpanded}
        aria-label={`${isExpanded ? 'Collapse' : 'Expand'} recalled memory`}
        onClick={() => setIsExpanded((current) => !current)}
        style={{
          appearance: 'none',
          background: 'transparent',
          border: 'none',
          color: theme.text.placeholder,
          cursor: 'pointer',
          padding: 0,
          textDecoration: 'underline',
          textUnderlineOffset: '3px',
          textDecorationColor: theme.border.strong
        }}
      >
        <Brain size={12} strokeWidth={1.9} style={{ color: theme.text.accent }} />
        <span style={{ fontSize: '11px' }}>
          {entries.length} recalled {entries.length === 1 ? 'memory' : 'memories'}
        </span>
        <span style={{ color: theme.text.placeholder, fontSize: '11px' }}>· {debugLabel}</span>
        <ChevronRight
          size={11}
          strokeWidth={1.8}
          style={{
            color: theme.text.placeholder,
            transform: isExpanded ? 'rotate(90deg)' : undefined,
            transition: 'transform 0.15s ease'
          }}
        />
      </button>

      {isExpanded ? (
        <div
          id={detailsId}
          className="mt-2 max-w-lg rounded-2xl px-4 py-3"
          style={{
            background: theme.background.surfaceSoft,
            border: `1px solid ${theme.border.panel}`,
            color: theme.text.secondary
          }}
        >
          <div
            className="mb-2"
            style={{
              color: theme.text.placeholder,
              fontSize: '10px',
              letterSpacing: '0.04em',
              textTransform: 'uppercase'
            }}
          >
            Memory used for this run
          </div>
          <div
            className="mb-3 text-[11px]"
            style={{ color: theme.text.placeholder, lineHeight: 1.5 }}
          >
            Reason: {debugLabel}
            {typeof recallDecision?.messagesSinceLastRecall === 'number' ? (
              <> · +{recallDecision.messagesSinceLastRecall} msgs</>
            ) : null}
            {typeof recallDecision?.charsSinceLastRecall === 'number' ? (
              <> · +{recallDecision.charsSinceLastRecall} chars</>
            ) : null}
          </div>
          <div className="flex flex-col gap-2">
            {entries.map((entry) => (
              <div key={entry} className="flex gap-2" style={{ fontSize: '12px', lineHeight: 1.5 }}>
                <span style={{ color: theme.text.accent }}>•</span>
                <span className="message-selectable whitespace-pre-wrap wrap-break-words">
                  {entry}
                </span>
              </div>
            ))}
          </div>
          {novelTerms.length > 0 ? (
            <div
              className="mt-3 text-[11px]"
              style={{ color: theme.text.placeholder, lineHeight: 1.5 }}
            >
              Novel terms: {novelTerms.join(' · ')}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
