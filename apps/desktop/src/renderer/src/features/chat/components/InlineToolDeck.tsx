import type React from 'react'
import { Fragment, useEffect, useId, useMemo, useRef, useState } from 'react'

import type { SubagentFinishedResult } from '@renderer/app/store/useAppStore'
import type { ToolCall } from '@renderer/app/types'
import { theme } from '@renderer/theme/theme'
import { useT } from '@yachiyo/i18n/react'
import {
  buildToolCallDetailsPresentation,
  buildToolCallRowSummary,
  getToolCallDetailBlocks
} from '../lib/tool-calls/toolCallPresentation.ts'
import { buildSubagentFinishedToolCall } from '../lib/tool-calls/subagentFinishedToolCall.ts'
import { getToolCallIcon } from '../lib/tool-calls/toolCallIcons.ts'
import { AskUserInlineWidget } from './AskUserInlineWidget.tsx'
import { ToolCallDetailsPanel } from './ToolCallDetailsPanel.tsx'

interface InlineToolDeckProps {
  toolCalls: ToolCall[]
  workspacePath?: string | null
  subagentFinishedResults?: SubagentFinishedResult[]
}
type DeckSelection = { kind: 'latest' } | { kind: 'fixed'; toolCallId: string } | null

function isForegroundToolCall(toolCall: ToolCall): boolean {
  return (
    toolCall.status === 'preparing' ||
    toolCall.status === 'running' ||
    toolCall.status === 'waiting-for-user'
  )
}

function getDeckSummaryToolCall(toolCalls: ToolCall[]): ToolCall | undefined {
  return toolCalls.findLast(isForegroundToolCall) ?? toolCalls.at(-1)
}

function getToolIconColor(toolCall: ToolCall): string {
  if (toolCall.status === 'failed') return theme.text.danger
  if (isForegroundToolCall(toolCall)) return theme.text.accent
  return theme.text.muted
}

function hydrateSubagentResult(
  toolCall: ToolCall,
  results: SubagentFinishedResult[],
  t: ReturnType<typeof useT>
): ToolCall {
  if (toolCall.toolName !== 'delegateTask') return toolCall
  const result = results.find((entry) => entry.delegationId === toolCall.id)
  if (!result) return toolCall

  const finishedToolCall = buildSubagentFinishedToolCall(result, t)
  return {
    ...toolCall,
    ...finishedToolCall,
    id: toolCall.id,
    threadId: toolCall.threadId,
    ...(toolCall.runId ? { runId: toolCall.runId } : {}),
    ...(toolCall.requestMessageId ? { requestMessageId: toolCall.requestMessageId } : {}),
    ...(toolCall.assistantMessageId ? { assistantMessageId: toolCall.assistantMessageId } : {}),
    startedAt: toolCall.startedAt,
    ...(toolCall.finishedAt ? { finishedAt: toolCall.finishedAt } : {})
  }
}

export function InlineToolDeck({
  toolCalls,
  workspacePath,
  subagentFinishedResults = []
}: InlineToolDeckProps): React.JSX.Element | null {
  const t = useT()
  const detailsId = useId()
  const [selection, setSelection] = useState<DeckSelection>(null)
  const [dismissedWaitingIds, setDismissedWaitingIds] = useState<ReadonlySet<string>>(
    () => new Set()
  )
  const buttonRefs = useRef(new Map<string, HTMLButtonElement>())

  const displayedToolCalls = useMemo(
    () => toolCalls.map((toolCall) => hydrateSubagentResult(toolCall, subagentFinishedResults, t)),
    [subagentFinishedResults, t, toolCalls]
  )
  const summaryToolCall = getDeckSummaryToolCall(displayedToolCalls)
  const autoSelectedWaitingToolCall =
    displayedToolCalls.findLast(
      (toolCall) =>
        toolCall.toolName === 'askUser' &&
        toolCall.status === 'waiting-for-user' &&
        !dismissedWaitingIds.has(toolCall.id)
    ) ?? null
  const selectedFromStateId =
    selection?.kind === 'latest' ? (summaryToolCall?.id ?? null) : (selection?.toolCallId ?? null)
  const selectedToolCallId = autoSelectedWaitingToolCall?.id ?? selectedFromStateId
  const selectedToolCall =
    displayedToolCalls.find((toolCall) => toolCall.id === selectedToolCallId) ?? null
  const selectedPresentation = selectedToolCall
    ? buildToolCallDetailsPresentation(selectedToolCall)
    : null
  const selectedHasDetails = selectedPresentation
    ? getToolCallDetailBlocks(selectedPresentation).length > 0
    : false
  const selectedCanExpand = selectedToolCall?.toolName === 'askUser' || Boolean(selectedHasDetails)

  const shouldFollowLatest = selection === null || selection.kind === 'latest'
  useEffect(() => {
    const targetToolCallId =
      autoSelectedWaitingToolCall?.id ?? (shouldFollowLatest ? summaryToolCall?.id : null)
    if (!targetToolCallId) return

    buttonRefs.current.get(targetToolCallId)?.scrollIntoView({
      block: 'nearest',
      inline: 'nearest'
    })
  }, [autoSelectedWaitingToolCall?.id, shouldFollowLatest, summaryToolCall?.id])

  if (!summaryToolCall) return null
  const displayedSummaryToolCall = selectedToolCall ?? summaryToolCall

  const summary = buildToolCallRowSummary(displayedSummaryToolCall, workspacePath)
  const summaryIsFailed = displayedSummaryToolCall.status === 'failed'

  return (
    <div className="px-6 py-1" data-tool-deck>
      <div className="flex min-w-0 items-center gap-2">
        <div
          className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto whitespace-nowrap py-0.5"
          role="group"
          aria-label={t('chat.tools.deckAria')}
        >
          {displayedToolCalls.map((toolCall) => {
            const Icon = getToolCallIcon(toolCall.toolName)
            const isSelected = selectedToolCallId === toolCall.id
            const presentation = buildToolCallDetailsPresentation(toolCall)
            const canExpand =
              toolCall.toolName === 'askUser' || getToolCallDetailBlocks(presentation).length > 0

            return (
              <Fragment key={toolCall.id}>
                <button
                  ref={(element) => {
                    if (element) buttonRefs.current.set(toolCall.id, element)
                    else buttonRefs.current.delete(toolCall.id)
                  }}
                  type="button"
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full"
                  data-tool-call-id={toolCall.id}
                  title={toolCall.toolName}
                  aria-controls={canExpand ? detailsId : undefined}
                  aria-expanded={canExpand ? isSelected : undefined}
                  aria-label={
                    canExpand
                      ? isSelected
                        ? t('chat.tools.collapseDetailsAria', { name: toolCall.toolName })
                        : t('chat.tools.expandDetailsAria', { name: toolCall.toolName })
                      : toolCall.toolName
                  }
                  aria-pressed={isSelected}
                  onClick={() => {
                    if (!canExpand) return
                    if (autoSelectedWaitingToolCall) {
                      setDismissedWaitingIds((current) => {
                        if (current.has(autoSelectedWaitingToolCall.id)) return current
                        const next = new Set(current)
                        next.add(autoSelectedWaitingToolCall.id)
                        return next
                      })
                    }
                    if (isSelected) {
                      setSelection(null)
                      return
                    }
                    setSelection(
                      toolCall.id === summaryToolCall.id
                        ? { kind: 'latest' }
                        : { kind: 'fixed', toolCallId: toolCall.id }
                    )
                  }}
                  style={{
                    appearance: 'none',
                    background: isSelected ? theme.background.accentMuted : 'transparent',
                    border: `1px solid ${isSelected ? theme.border.accent : theme.border.panel}`,
                    color: getToolIconColor(toolCall),
                    cursor: 'default',
                    opacity: 1,
                    padding: 0
                  }}
                >
                  <Icon
                    size={14}
                    strokeWidth={1.8}
                    aria-hidden="true"
                    style={{
                      animation: isForegroundToolCall(toolCall)
                        ? 'yachiyo-preparing-pulse 1.2s ease-in-out infinite'
                        : undefined
                    }}
                  />
                </button>
                {displayedSummaryToolCall.id === toolCall.id ? (
                  <div
                    className="yachiyo-tool-deck-drawer flex min-w-0 max-w-[70%] items-center gap-1.5 overflow-hidden whitespace-nowrap px-1"
                    data-tool-call-summary-id={toolCall.id}
                    style={{ color: theme.text.muted, fontSize: '11px' }}
                  >
                    <span className="shrink-0" style={{ color: theme.text.placeholder }}>
                      {displayedSummaryToolCall.toolName}
                    </span>
                    {summary.inputSummary ? (
                      <span className="truncate" style={{ color: theme.text.secondary }}>
                        · {summary.inputSummary}
                      </span>
                    ) : null}
                    {displayedSummaryToolCall.cwd &&
                    (!workspacePath || displayedSummaryToolCall.cwd !== workspacePath) ? (
                      <span className="truncate">· cwd {displayedSummaryToolCall.cwd}</span>
                    ) : null}
                    {summary.outputSummary ? (
                      <span
                        className="truncate"
                        style={{
                          color: summaryIsFailed ? theme.text.danger : theme.text.placeholder
                        }}
                      >
                        · {summary.outputSummary}
                      </span>
                    ) : null}
                  </div>
                ) : null}
              </Fragment>
            )
          })}
        </div>
      </div>

      {selectedToolCall && selectedCanExpand ? (
        selectedToolCall.toolName === 'askUser' ? (
          <div id={detailsId} className="mt-1.5 yachiyo-detail-reveal">
            <AskUserInlineWidget toolCall={selectedToolCall} nested />
          </div>
        ) : selectedPresentation ? (
          <ToolCallDetailsPanel
            id={detailsId}
            presentation={selectedPresentation}
            className="mt-1.5 ml-3"
            nested
          />
        ) : null
      ) : null}
    </div>
  )
}
