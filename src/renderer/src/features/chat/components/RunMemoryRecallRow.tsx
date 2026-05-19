import type React from 'react'
import { useId, useState } from 'react'
import { Brain, ChevronRight } from 'lucide-react'
import type { RecallDecisionSnapshot } from '@renderer/app/types'
import { theme } from '@renderer/theme/theme'
import { compactNovelTermsForDisplay } from '../lib/runMemoryPresentation.ts'

interface ParsedCognitiveEntry {
  relation: string
  key: string
  fields: Record<string, string>
}

function tryParseCognitiveEntry(text: string): ParsedCognitiveEntry | null {
  const match = /^\[([^\]]+)\]\s+([^:]+):\s+(.+)$/.exec(text)
  if (!match) return null

  const relation = match[1]!.trim()
  const key = match[2]!.trim()
  const fieldsText = match[3]!.trim()
  if (!relation || !key || !fieldsText) return null

  const fields: Record<string, string> = {}
  for (const part of fieldsText.split(';')) {
    const trimmed = part.trim()
    if (!trimmed) continue
    const eqIndex = trimmed.indexOf('=')
    if (eqIndex <= 0) continue
    const fieldKey = trimmed.slice(0, eqIndex).trim()
    const fieldValue = trimmed.slice(eqIndex + 1).trim()
    if (fieldKey) fields[fieldKey] = fieldValue
  }

  if (Object.keys(fields).length === 0) return null
  return { relation, key, fields }
}

interface MemoryEntryCardProps {
  entry: string
}

function MemoryEntryCard({ entry }: MemoryEntryCardProps): React.JSX.Element {
  const parsed = tryParseCognitiveEntry(entry)

  if (!parsed) {
    return (
      <div className="flex gap-2" style={{ fontSize: '12px', lineHeight: 1.5 }}>
        <span style={{ color: theme.text.accent }}>•</span>
        <span className="message-selectable whitespace-pre-wrap wrap-break-words">{entry}</span>
      </div>
    )
  }

  return (
    <div style={{ fontSize: '12px', lineHeight: 1.5 }}>
      <div className="message-selectable" style={{ color: theme.text.primary }}>
        <span style={{ color: theme.text.accent }}>{parsed.relation}</span>{' '}
        <span className="font-medium">{parsed.key}</span>
      </div>
      <div
        className="message-selectable flex flex-col"
        style={{ color: theme.text.secondary, gap: '1px' }}
      >
        {Object.entries(parsed.fields).map(([fieldKey, fieldValue]) => (
          <div key={fieldKey} className="flex gap-1">
            <span style={{ color: theme.text.placeholder }}>{fieldKey}</span>
            <span
              className="whitespace-pre-wrap wrap-break-words"
              style={{ maxHeight: '4em', overflowY: 'auto' }}
            >
              {fieldValue}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

interface RunMemoryRecallRowProps {
  entries: string[]
  recallDecision?: RecallDecisionSnapshot
}

function formatReason(reason: string): string {
  switch (reason) {
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
  const novelTerms = shouldShowNovelTerms
    ? compactNovelTermsForDisplay(recallDecision?.novelTerms)
    : []

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
          cursor: 'default',
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
          className="mt-2 max-w-lg pl-3"
          style={{
            borderLeft: `1px solid ${theme.border.subtle}`,
            color: theme.text.secondary
          }}
        >
          <div className="mb-1" style={{ color: theme.text.placeholder, fontSize: '11px' }}>
            Reason: {debugLabel}
          </div>
          <div className="flex flex-col gap-3">
            {entries.map((entry, index) => (
              <MemoryEntryCard key={`${index}:${entry.slice(0, 40)}`} entry={entry} />
            ))}
          </div>
          {novelTerms.length > 0 ? (
            <div
              className="mt-2 text-[11px]"
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
