import type React from 'react'
import { useId, useState } from 'react'
import { Brain, ChevronRight } from 'lucide-react'
import { tPlural } from '@yachiyo/i18n/index'
import { useT } from '@yachiyo/i18n/react'
import { theme } from '@renderer/theme/theme'
import { parseRecalledMemories } from '../lib/run-memory/runMemoryPresentation.ts'
import type { RecalledMemory } from '../lib/run-memory/runMemoryPresentation.ts'

function RecalledMemoryItem({ memory }: { memory: RecalledMemory }): React.JSX.Element {
  if (memory.kind === 'note') {
    return (
      <div className="flex gap-2" style={{ fontSize: '12px', lineHeight: 1.5 }}>
        <span style={{ color: theme.text.accent }}>•</span>
        <span className="message-selectable whitespace-pre-wrap wrap-break-words">
          {memory.text}
        </span>
      </div>
    )
  }

  return (
    <div style={{ fontSize: '12px', lineHeight: 1.5 }}>
      <div className="message-selectable font-medium" style={{ color: theme.text.primary }}>
        {memory.title}
      </div>
      <div
        className="message-selectable flex flex-col"
        style={{ color: theme.text.secondary, gap: '1px' }}
      >
        {memory.fields.map(([fieldKey, fieldValue]) => (
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

export function RunMemoryRecallRow({ entries }: { entries: string[] }): React.JSX.Element {
  const t = useT()
  const [isExpanded, setIsExpanded] = useState(false)
  const detailsId = useId()
  const memories = parseRecalledMemories(entries)

  return (
    <div className="px-6 pb-1">
      <button
        type="button"
        className="inline-flex items-center gap-1.5 text-left"
        aria-controls={detailsId}
        aria-expanded={isExpanded}
        aria-label={
          isExpanded ? t('chat.memoryRecall.collapseAria') : t('chat.memoryRecall.expandAria')
        }
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
          {tPlural('chat.memoryRecall.recalled', memories.length)}
        </span>
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
          <div className="flex flex-col gap-3">
            {memories.map((memory, index) => (
              <RecalledMemoryItem key={index} memory={memory} />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  )
}
