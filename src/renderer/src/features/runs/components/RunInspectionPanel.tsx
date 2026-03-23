import type React from 'react'
import { useState } from 'react'
import { Brain, ChevronRight } from 'lucide-react'
import { useAppStore } from '@renderer/app/store/useAppStore'
import type { RunContextSourceSummary, RunRecord, ToolCall } from '@renderer/app/types'
import { theme } from '@renderer/theme/theme'
import { buildToolCallDetailsPresentation } from '@renderer/features/chat/lib/toolCallPresentation'
import {
  buildRunInspectionViewModel,
  type ContextSource,
  type ThreadContextSource
} from '../lib/runInspectionPresentation'

const EMPTY_RUNS: RunRecord[] = []
const EMPTY_TOOL_CALLS: ToolCall[] = []

// ---- Run status ----

function formatRunDuration(run: RunRecord): string {
  if (!run.completedAt) {
    return ''
  }

  const ms = new Date(run.completedAt).getTime() - new Date(run.createdAt).getTime()
  if (ms < 1000) {
    return `${ms}ms`
  }

  return `${(ms / 1000).toFixed(1)}s`
}

function runStatusColor(status: RunRecord['status']): string {
  if (status === 'running') {
    return theme.text.accent
  }

  if (status === 'failed' || status === 'cancelled') {
    return theme.text.danger
  }

  return theme.text.success
}

// ---- Context source rows ----

function formatRecallReason(reason: string): string {
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
      return 'topic novelty'
    case 'recall-failed':
      return 'recall failed'
    default:
      return reason
  }
}

function sourceKindLabel(kind: RunContextSourceSummary['kind']): string {
  switch (kind) {
    case 'persona':
      return 'Persona'
    case 'soul':
      return 'Soul'
    case 'user':
      return 'User'
    case 'agent':
      return 'Agent'
    case 'memory':
      return 'Memory'
    case 'handoff':
      return 'Handoff'
    case 'hint':
      return 'Hint'
    case 'toolReminder':
      return 'Tool changes'
    default:
      return kind
  }
}

function ThreadSourceRow({ source }: { source: ThreadContextSource }): React.JSX.Element {
  return (
    <div className="flex items-center gap-1.5">
      <span style={{ color: theme.text.secondary, fontSize: '11px' }}>Thread</span>
      <span style={{ color: theme.text.placeholder, fontSize: '11px' }}>
        · {source.messageCount} {source.messageCount === 1 ? 'message' : 'messages'}
      </span>
      {source.workspacePath ? (
        <span
          className="truncate"
          style={{ color: theme.text.placeholder, fontSize: '11px', maxWidth: '120px' }}
          title={source.workspacePath}
        >
          · {source.workspacePath.split('/').pop()}
        </span>
      ) : null}
    </div>
  )
}

function MemorySourceRow({
  source,
  entries
}: {
  source: RunContextSourceSummary
  entries: string[]
}): React.JSX.Element {
  const [isExpanded, setIsExpanded] = useState(false)
  const reasons = source.reasons?.map(formatRecallReason) ?? []
  const reasonLabel = reasons.length > 0 ? reasons.join(', ') : null

  if (!source.present) {
    return (
      <div className="flex items-center gap-1.5">
        <Brain
          size={12}
          strokeWidth={1.8}
          style={{ color: theme.text.placeholder, flexShrink: 0 }}
        />
        <span style={{ color: theme.text.muted, fontSize: '11px' }}>Memory</span>
        <span style={{ color: theme.text.muted, fontSize: '11px' }}>
          · not recalled
          {reasonLabel ? ` · ${reasonLabel}` : ''}
        </span>
      </div>
    )
  }

  return (
    <div>
      <button
        type="button"
        className="flex w-full items-center gap-1.5 text-left"
        onClick={() => setIsExpanded((v) => !v)}
        style={{
          appearance: 'none',
          background: 'transparent',
          border: 0,
          cursor: 'pointer',
          margin: 0,
          padding: 0
        }}
      >
        <Brain size={12} strokeWidth={1.8} style={{ color: theme.text.accent, flexShrink: 0 }} />
        <span style={{ color: theme.text.secondary, fontSize: '11px' }}>Memory</span>
        <span style={{ color: theme.text.placeholder, fontSize: '11px' }}>
          · {source.count ?? entries.length} recalled
          {reasonLabel ? ` · ${reasonLabel}` : ''}
        </span>
        <ChevronRight
          size={10}
          strokeWidth={1.8}
          style={{
            color: theme.text.placeholder,
            flexShrink: 0,
            marginLeft: 'auto',
            transform: isExpanded ? 'rotate(90deg)' : undefined,
            transition: 'transform 0.15s ease'
          }}
        />
      </button>

      {isExpanded && entries.length > 0 ? (
        <div className="mt-2 ml-4 flex flex-col gap-1.5">
          {entries.map((entry) => (
            <div
              key={entry}
              className="flex gap-1.5"
              style={{ color: theme.text.secondary, fontSize: '11px', lineHeight: 1.5 }}
            >
              <span style={{ color: theme.text.accent, flexShrink: 0 }}>•</span>
              <span className="message-selectable whitespace-pre-wrap wrap-break-words">
                {entry}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}

function SimpleSourceRow({ source }: { source: RunContextSourceSummary }): React.JSX.Element {
  const label = sourceKindLabel(source.kind)

  if (!source.present) {
    return (
      <div className="flex items-center gap-1.5">
        <span style={{ color: theme.text.muted, fontSize: '11px' }}>{label}</span>
        <span style={{ color: theme.text.muted, fontSize: '11px' }}>· inactive</span>
      </div>
    )
  }

  return (
    <div className="flex items-center gap-1.5">
      <span style={{ color: theme.text.secondary, fontSize: '11px' }}>{label}</span>
      <span style={{ color: theme.text.placeholder, fontSize: '11px' }}>
        · {source.summary ?? 'active'}
      </span>
    </div>
  )
}

function ContextSourceRow({
  source,
  recalledEntries
}: {
  source: ContextSource
  recalledEntries: string[]
}): React.JSX.Element {
  if (source.kind === 'thread') {
    return <ThreadSourceRow source={source} />
  }

  if (source.kind === 'memory') {
    return <MemorySourceRow source={source} entries={recalledEntries} />
  }

  return <SimpleSourceRow source={source} />
}

// ---- Tool call detail section ----

interface InspectionToolCallRowProps {
  toolCall: ToolCall
}

function InspectionToolCallRow({ toolCall }: InspectionToolCallRowProps): React.JSX.Element {
  const [isExpanded, setIsExpanded] = useState(false)
  const presentation = buildToolCallDetailsPresentation(toolCall)
  // Inspection panel shows ALL tiers (both secondary and inspection)
  const allCodeBlocks = presentation.codeBlocks
  const hasDetail = presentation.fields.length > 0 || allCodeBlocks.length > 0
  const isRunning = toolCall.status === 'running'
  const isFailed = toolCall.status === 'failed'
  const dotColor = isFailed
    ? theme.status.danger
    : isRunning
      ? theme.text.accent
      : theme.status.success

  return (
    <div className="py-1">
      <button
        type="button"
        className="flex w-full items-start gap-1.5 text-left"
        disabled={!hasDetail}
        onClick={() => setIsExpanded((v) => !v)}
        style={{
          appearance: 'none',
          background: 'transparent',
          border: 0,
          color: theme.text.muted,
          cursor: hasDetail ? 'pointer' : 'default',
          fontSize: '11px',
          margin: 0,
          padding: 0
        }}
      >
        <span
          className="mt-0.5 w-1.5 h-1.5 rounded-full shrink-0"
          style={{
            background: dotColor,
            animation: isRunning ? 'yachiyo-preparing-pulse 1.2s ease-in-out infinite' : undefined
          }}
        />
        <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1 truncate">
          <span className="font-medium" style={{ color: theme.text.secondary }}>
            {toolCall.toolName}
          </span>
          <span className="truncate">{toolCall.inputSummary}</span>
          {toolCall.outputSummary ? (
            <span style={{ color: isFailed ? theme.text.danger : theme.text.placeholder }}>
              · {toolCall.outputSummary}
            </span>
          ) : null}
        </span>
        {hasDetail ? (
          <ChevronRight
            size={10}
            strokeWidth={1.8}
            style={{
              color: theme.text.placeholder,
              flexShrink: 0,
              marginTop: '2px',
              transform: isExpanded ? 'rotate(90deg)' : undefined,
              transition: 'transform 0.15s ease'
            }}
          />
        ) : null}
      </button>

      {isExpanded && hasDetail ? (
        <div
          className="mt-1.5 ml-3 flex flex-col gap-1.5 border-l pl-3"
          style={{ borderColor: theme.border.panel }}
        >
          {presentation.fields.length > 0 ? (
            <div
              className="flex flex-wrap gap-x-3 gap-y-0.5"
              style={{ color: theme.text.placeholder, fontSize: '10.5px' }}
            >
              {presentation.fields.map((field) => (
                <span key={`${field.label}:${field.value}`}>
                  <span style={{ opacity: 0.72 }}>{field.label}</span>{' '}
                  <span
                    className="break-all"
                    style={{
                      color: field.tone === 'danger' ? theme.text.danger : theme.text.tertiary,
                      fontFamily: "ui-monospace, 'SF Mono', Menlo, monospace"
                    }}
                  >
                    {field.value}
                  </span>
                </span>
              ))}
            </div>
          ) : null}

          {allCodeBlocks.map((block) => (
            <div key={`${block.label}:${block.value.slice(0, 32)}`}>
              <div
                style={{
                  color: block.tone === 'danger' ? theme.text.danger : theme.text.placeholder,
                  fontSize: '10px',
                  letterSpacing: '0.04em',
                  marginBottom: '3px',
                  textTransform: 'uppercase'
                }}
              >
                {block.label}
                {block.displayTier === 'inspection' ? (
                  <span
                    className="ml-1.5 rounded px-1 py-px"
                    style={{
                      background: theme.background.accentMuted,
                      color: theme.text.accent,
                      fontSize: '9px',
                      letterSpacing: '0.03em',
                      textTransform: 'none'
                    }}
                  >
                    full
                  </span>
                ) : null}
              </div>
              <pre
                className="message-selectable overflow-auto rounded-md px-2.5 py-2"
                style={{
                  background:
                    block.tone === 'danger'
                      ? theme.background.dangerSoft
                      : theme.background.codeBlock,
                  border: `1px solid ${
                    block.tone === 'danger' ? theme.border.danger : theme.border.default
                  }`,
                  color: block.tone === 'danger' ? theme.text.dangerStrong : theme.text.secondary,
                  fontFamily: "ui-monospace, 'SF Mono', Menlo, monospace",
                  fontSize: '10px',
                  lineHeight: 1.5,
                  margin: 0,
                  maxHeight: '140px',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word'
                }}
              >
                {block.value}
              </pre>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}

// ---- Main panel ----

export interface RunInspectionPanelProps {
  threadId: string | null
}

export function RunInspectionPanel({ threadId }: RunInspectionPanelProps): React.JSX.Element {
  const runs = useAppStore((state) =>
    threadId ? (state.runsByThread[threadId] ?? EMPTY_RUNS) : EMPTY_RUNS
  )
  const toolCalls = useAppStore((state) =>
    threadId ? (state.toolCalls[threadId] ?? EMPTY_TOOL_CALLS) : EMPTY_TOOL_CALLS
  )
  const thread = useAppStore((state) =>
    threadId ? (state.threads.find((t) => t.id === threadId) ?? null) : null
  )
  const messageCount = useAppStore((state) =>
    threadId ? (state.messages[threadId]?.length ?? 0) : 0
  )

  const vm = buildRunInspectionViewModel(runs, toolCalls, thread, messageCount)
  const recalledEntries = vm.run?.recalledMemoryEntries?.filter((e) => e.trim()) ?? []

  const contextSourcesSection = (
    <div className="px-4 py-3" style={{ borderTop: `1px solid ${theme.border.subtle}` }}>
      <div
        className="mb-2 text-[10px] font-medium uppercase tracking-wider"
        style={{ color: theme.text.placeholder, letterSpacing: '0.05em' }}
      >
        Context Sources
      </div>
      <div className="flex flex-col gap-1.5">
        {vm.contextSources.map((source) => (
          <ContextSourceRow key={source.kind} source={source} recalledEntries={recalledEntries} />
        ))}
      </div>
    </div>
  )

  return (
    <div
      className="flex flex-col shrink-0 overflow-hidden"
      style={{
        borderLeft: `1px solid ${theme.border.default}`,
        width: '300px'
      }}
    >
      {/* Panel header */}
      <div
        className="flex items-center shrink-0 px-4"
        style={{
          borderBottom: `1px solid ${theme.border.default}`,
          height: '40px'
        }}
      >
        <span
          className="text-[11px] font-semibold uppercase tracking-wider"
          style={{ color: theme.text.placeholder, letterSpacing: '0.06em' }}
        >
          Run Inspector
        </span>
      </div>

      {/* Panel body */}
      <div className="flex-1 overflow-y-auto">
        {!vm.run ? (
          <>
            {contextSourcesSection}
            <div
              className="flex items-center justify-center px-4 pb-4"
              style={{ color: theme.text.muted, fontSize: '12px', textAlign: 'center' }}
            >
              No runs yet for this thread.
            </div>
          </>
        ) : (
          <>
            {/* Run status section */}
            <div className="px-4 py-3">
              <div
                className="mb-1.5 text-[10px] font-medium uppercase tracking-wider"
                style={{ color: theme.text.placeholder, letterSpacing: '0.05em' }}
              >
                Latest Run
              </div>
              <div className="flex items-center gap-1.5">
                <span
                  className="w-1.5 h-1.5 rounded-full shrink-0"
                  style={{
                    background: runStatusColor(vm.run.status),
                    animation:
                      vm.run.status === 'running'
                        ? 'yachiyo-preparing-pulse 1.2s ease-in-out infinite'
                        : undefined
                  }}
                />
                <span style={{ color: theme.text.secondary, fontSize: '11px' }}>
                  {vm.run.status}
                </span>
                {vm.run.status !== 'running' && vm.run.completedAt ? (
                  <span style={{ color: theme.text.placeholder, fontSize: '11px' }}>
                    · {formatRunDuration(vm.run)}
                  </span>
                ) : null}
              </div>
              {vm.run.error ? (
                <div
                  className="mt-1.5 rounded-md px-2.5 py-1.5 text-[11px]"
                  style={{
                    background: theme.background.dangerSoft,
                    border: `1px solid ${theme.border.danger}`,
                    color: theme.text.dangerStrong,
                    fontFamily: "ui-monospace, 'SF Mono', Menlo, monospace"
                  }}
                >
                  {vm.run.error}
                </div>
              ) : null}
            </div>

            {contextSourcesSection}

            {/* Tool calls section */}
            {vm.toolCalls.length > 0 ? (
              <div className="px-4 py-3" style={{ borderTop: `1px solid ${theme.border.subtle}` }}>
                <div
                  className="mb-2 text-[10px] font-medium uppercase tracking-wider"
                  style={{ color: theme.text.placeholder, letterSpacing: '0.05em' }}
                >
                  Tools · {vm.toolCalls.length}
                </div>
                <div className="flex flex-col divide-y" style={{ gap: '0' }}>
                  {vm.toolCalls.map((toolCall) => (
                    <InspectionToolCallRow key={toolCall.id} toolCall={toolCall} />
                  ))}
                </div>
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  )
}
