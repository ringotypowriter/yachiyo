import React, { memo, useEffect, useMemo, useState } from 'react'
import { CheckCircle2, FileText, GitBranchPlus, XCircle } from 'lucide-react'
import { useT } from '@yachiyo/i18n/react'
import { MessageMarkdown } from '@renderer/lib/markdown/MessageMarkdown'
import { theme, alpha } from '@renderer/theme/theme'
import type { InlineCodeFileLinkSnapshot } from '@renderer/lib/markdown/inlineCodeFileLinkSnapshot'

export interface PlanDocumentCardProps {
  title?: string
  path?: string
  content: string
  decision?: 'pending' | 'rejected' | 'accepted'
  defaultExpanded?: boolean
  inlineCodeFileLinks?: InlineCodeFileLinkSnapshot
  onAcceptDirect?: () => void
  onAcceptHandoff?: () => void
  onReject?: () => void
}

export const PlanDocumentCard = memo(function PlanDocumentCard({
  title,
  path,
  content,
  decision = 'pending',
  defaultExpanded = true,
  inlineCodeFileLinks,
  onAcceptDirect,
  onAcceptHandoff,
  onReject
}: PlanDocumentCardProps): React.JSX.Element {
  const t = useT()
  const [expanded, setExpanded] = useState(defaultExpanded)
  const resolvedTitle = title ?? t('chat.plan.title')

  useEffect(() => {
    setExpanded(defaultExpanded)
  }, [defaultExpanded])

  const headerLabel = useMemo(() => {
    if (decision === 'accepted') return t('chat.plan.accepted')
    if (decision === 'rejected') return t('chat.plan.rejected')
    return t('chat.plan.ready')
  }, [decision, t])

  const headerTone =
    decision === 'accepted'
      ? { bg: alpha('accent', 0.12), fg: theme.text.accent }
      : decision === 'rejected'
        ? { bg: alpha('danger', 0.12), fg: theme.text.danger }
        : { bg: alpha('ink', 0.06), fg: theme.text.muted }

  const showActions = decision === 'pending' && (onAcceptDirect || onAcceptHandoff || onReject)

  return (
    <div className="px-6 py-1">
      <div
        style={{
          borderRadius: 14,
          border: `1px solid ${theme.border.default}`,
          background: theme.background.surface,
          boxShadow: theme.shadow.card
        }}
      >
        <div
          className="flex items-center gap-2"
          style={{
            padding: '10px 12px',
            borderBottom: `1px solid ${theme.border.subtle}`
          }}
        >
          <FileText size={14} strokeWidth={1.8} style={{ color: theme.text.accent }} />
          <div className="min-w-0 flex-1">
            <div
              className="flex items-center gap-2"
              style={{
                fontSize: 12.5,
                fontWeight: 650,
                color: theme.text.primary,
                letterSpacing: '-0.05px'
              }}
            >
              <span className="truncate">{resolvedTitle}</span>
              <span
                className="shrink-0"
                style={{
                  padding: '2px 6px',
                  borderRadius: 999,
                  background: headerTone.bg,
                  color: headerTone.fg,
                  fontSize: 10.5,
                  fontWeight: 650
                }}
              >
                {headerLabel}
              </span>
            </div>
            {path ? (
              <div
                className="truncate"
                style={{
                  marginTop: 2,
                  fontSize: 11,
                  color: theme.text.placeholder,
                  fontFamily: "ui-monospace, 'SF Mono', Menlo, monospace"
                }}
              >
                {path}
              </div>
            ) : null}
          </div>

          {showActions ? (
            <div className="flex items-center gap-1.5 shrink-0">
              {onReject ? (
                <button
                  type="button"
                  onClick={onReject}
                  className="inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] transition-colors"
                  style={{
                    color: theme.text.danger,
                    background: alpha('danger', 0.06),
                    border: `1px solid ${alpha('danger', 0.16)}`
                  }}
                >
                  <XCircle size={12} strokeWidth={1.8} />
                  {t('chat.plan.reject')}
                </button>
              ) : null}
              {onAcceptDirect ? (
                <button
                  type="button"
                  onClick={onAcceptDirect}
                  className="inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] transition-colors"
                  style={{
                    color: theme.text.accent,
                    background: alpha('accent', 0.08),
                    border: `1px solid ${alpha('accent', 0.18)}`
                  }}
                >
                  <CheckCircle2 size={12} strokeWidth={1.8} />
                  {t('chat.plan.acceptDirectly')}
                </button>
              ) : null}
              {onAcceptHandoff ? (
                <button
                  type="button"
                  onClick={onAcceptHandoff}
                  className="inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] transition-colors"
                  style={{
                    color: theme.text.accent,
                    background: alpha('accent', 0.08),
                    border: `1px solid ${alpha('accent', 0.18)}`
                  }}
                >
                  <GitBranchPlus size={12} strokeWidth={1.8} />
                  {t('chat.plan.acceptWithHandoff')}
                </button>
              ) : null}
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setExpanded((prev) => !prev)}
              className="rounded px-2 py-1 text-[11px] transition-colors"
              style={{
                color: theme.text.muted,
                background: alpha('ink', 0.03),
                border: `1px solid ${theme.border.subtle}`
              }}
            >
              {expanded ? t('chat.collapse') : t('chat.expand')}
            </button>
          )}
        </div>

        {expanded ? (
          <div style={{ padding: '10px 12px 12px' }}>
            <MessageMarkdown
              content={content}
              isStreaming={false}
              inlineCodeFileLinks={inlineCodeFileLinks}
            />
          </div>
        ) : null}
      </div>
    </div>
  )
})
