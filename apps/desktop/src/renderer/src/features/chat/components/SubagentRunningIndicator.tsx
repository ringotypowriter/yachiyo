import { useState, useEffect, useId, useLayoutEffect, useMemo, useRef } from 'react'
import type React from 'react'
import { ChevronDown, ChevronUp, Clock } from 'lucide-react'
import type { ToolCall } from '@renderer/app/types'
import { theme } from '@renderer/theme/theme'
import { useT } from '@yachiyo/i18n/react'
import {
  resolveSubagentIndicatorAgent,
  resolveSubagentIndicatorTabIndex
} from './subagentIndicatorState'
import { ToolCallRow } from './ToolCallRow'

interface SubagentToolCallPreview {
  toolCallId?: string
  toolName: string
  inputSummary: string
  outputSummary?: string
  status?: 'running' | 'completed' | 'failed'
}

interface SubagentAgent {
  delegationId: string
  agentName: string
  agentType?: string
  codeName?: string
  prompt?: string
  progress: string
  startedAt?: string
  recentToolCalls?: SubagentToolCallPreview[]
}

interface SubagentProgressEntry {
  delegationId: string
  agentName: string
  chunk: string
}

interface SubagentRunningIndicatorProps {
  agents: SubagentAgent[]
  progressEntries: SubagentProgressEntry[]
}

function formatDurationMs(ms: number): string {
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`
  const m = Math.floor(ms / 60_000)
  const s = Math.floor((ms % 60_000) / 1000)
  return s > 0 ? `${m}m ${s}s` : `${m}m`
}

function useElapsed(startedAt?: string): number {
  const [now, setNow] = useState(0)
  useEffect(() => {
    if (!startedAt) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [startedAt])
  if (!startedAt || now === 0) return 0
  return Math.max(0, now - new Date(startedAt).getTime())
}

function toNestedToolCall(toolCall: SubagentToolCallPreview, index: number): ToolCall {
  return {
    id: toolCall.toolCallId ?? `${toolCall.toolName}:${index}`,
    threadId: 'subagent-preview',
    toolName: toolCall.toolName,
    status: toolCall.status ?? 'running',
    inputSummary: toolCall.inputSummary,
    ...(toolCall.outputSummary ? { outputSummary: toolCall.outputSummary } : {}),
    startedAt: new Date(0).toISOString()
  }
}

function AgentPanel({ agent }: { agent: SubagentAgent }): React.JSX.Element {
  const t = useT()
  const recent = agent.recentToolCalls ?? []

  return (
    <div className="px-3 py-2">
      {agent.prompt ? (
        <div>
          <div
            className="mb-1 text-[10px] uppercase tracking-[0.04em]"
            style={{ color: theme.text.placeholder }}
          >
            {t('chat.subagents.prompt')}
          </div>
          <div
            className="message-selectable overflow-auto rounded-md px-2.5 py-2 text-[11px]"
            style={{
              background: theme.background.hover,
              color: theme.text.secondary,
              lineHeight: 1.55,
              maxHeight: '112px',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word'
            }}
          >
            {agent.prompt}
          </div>
        </div>
      ) : null}

      <div className={agent.prompt ? 'mt-2' : undefined}>
        <div className="mb-1 flex items-center justify-between gap-2">
          <span
            className="text-[10px] uppercase tracking-[0.04em]"
            style={{ color: theme.text.placeholder }}
          >
            {t('chat.subagents.recentToolCalls')}
          </span>
          <span className="text-[10px]" style={{ color: theme.text.placeholder }}>
            {t('chat.subagents.latestOfTotal', { shown: Math.min(recent.length, 5), total: 5 })}
          </span>
        </div>
        <div
          className="overflow-auto rounded-md px-2.5 py-1.5"
          style={{
            background: theme.background.hover,
            maxHeight: '132px'
          }}
        >
          {recent.length > 0 ? (
            recent.map((toolCall, index) => (
              <ToolCallRow
                key={toolCall.toolCallId ?? `${toolCall.toolName}:${index}`}
                toolCall={toNestedToolCall(toolCall, index)}
                nested
              />
            ))
          ) : (
            <div className="py-0.5 text-[11px]" style={{ color: theme.text.placeholder }}>
              {t('chat.tools.waitingForToolCalls')}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export function SubagentRunningIndicator({
  agents
}: SubagentRunningIndicatorProps): React.JSX.Element {
  const t = useT()
  const indicatorId = useId()
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({})
  const focusedTabIdRef = useRef<string | null>(null)
  const summaryButtonRef = useRef<HTMLButtonElement>(null)
  const [expanded, setExpanded] = useState(true)
  const [selectedDelegationId, setSelectedDelegationId] = useState<string | null>(
    () => agents[0]?.delegationId ?? null
  )
  const selectedAgent = resolveSubagentIndicatorAgent(agents, selectedDelegationId)
  const elapsed = useElapsed(selectedAgent?.startedAt)

  useLayoutEffect(() => {
    if (!selectedAgent) return
    if (agents.length === 1 && focusedTabIdRef.current) {
      focusedTabIdRef.current = null
      summaryButtonRef.current?.focus()
      return
    }
    if (selectedAgent.delegationId === selectedDelegationId) return
    if (focusedTabIdRef.current === selectedDelegationId) {
      tabRefs.current[selectedAgent.delegationId]?.focus()
    }
  }, [agents.length, selectedAgent, selectedDelegationId])

  function handleTabKeyDown(
    event: React.KeyboardEvent<HTMLButtonElement>,
    currentIndex: number
  ): void {
    if (
      event.key !== 'ArrowLeft' &&
      event.key !== 'ArrowRight' &&
      event.key !== 'Home' &&
      event.key !== 'End'
    ) {
      return
    }

    const nextIndex = resolveSubagentIndicatorTabIndex(agents.length, currentIndex, event.key)
    const nextAgent = agents[nextIndex]
    if (!nextAgent) return

    event.preventDefault()
    setSelectedDelegationId(nextAgent.delegationId)
    tabRefs.current[nextAgent.delegationId]?.focus()
  }

  const headerText = useMemo(() => {
    if (agents.length === 0) return t('chat.subagents.noActiveAgents')
    if (agents.length === 1) {
      const name = agents[0]?.codeName ?? agents[0]?.agentName ?? t('chat.subagents.agentFallback')
      return t('chat.subagents.agentWorking', { name })
    }
    return t('chat.subagents.agentsWorking', { count: agents.length })
  }, [agents, t])

  return (
    <div className="px-6 py-1">
      <div className="flex items-center gap-2 mt-1">
        {agents.length === 1 ? (
          <span
            className="w-1.5 h-1.5 rounded-full shrink-0"
            style={{
              background: theme.text.accent,
              display: 'inline-block',
              animation: 'yachiyo-generating-pulse 1s ease-in-out infinite'
            }}
          />
        ) : null}

        <button
          ref={summaryButtonRef}
          onClick={() => setExpanded((v) => !v)}
          className="flex items-center gap-1 text-xs"
          style={{
            color: theme.text.muted,
            background: 'none',
            border: 'none',
            cursor: 'default',
            padding: 0,
            fontFamily: theme.font.ui
          }}
        >
          <span>{headerText}</span>
          {expanded ? (
            <ChevronUp size={11} style={{ opacity: 0.55 }} />
          ) : (
            <ChevronDown size={11} style={{ opacity: 0.55 }} />
          )}
        </button>
      </div>

      {expanded && selectedAgent ? (
        <div
          className="mt-2 overflow-hidden rounded-lg"
          style={{
            background: theme.background.surface,
            border: `1px solid ${theme.border.subtle}`,
            boxShadow: '0 1px 2px rgba(0,0,0,0.02)'
          }}
        >
          <div
            className="flex items-stretch justify-between"
            style={{ borderBottom: `1px solid ${theme.border.subtle}` }}
          >
            {agents.length > 1 ? (
              <div
                className="flex min-w-0 flex-1 overflow-x-auto px-1.5"
                role="tablist"
                aria-label={headerText}
              >
                {agents.map((agent, index) => {
                  const codeName = agent.codeName ?? agent.agentName
                  const selected = agent.delegationId === selectedAgent.delegationId
                  return (
                    <button
                      key={agent.delegationId}
                      ref={(node) => {
                        tabRefs.current[agent.delegationId] = node
                      }}
                      id={`${indicatorId}-tab-${index}`}
                      type="button"
                      role="tab"
                      tabIndex={selected ? 0 : -1}
                      aria-selected={selected}
                      aria-controls={`${indicatorId}-panel`}
                      onClick={() => setSelectedDelegationId(agent.delegationId)}
                      onFocus={() => {
                        focusedTabIdRef.current = agent.delegationId
                      }}
                      onBlur={() => {
                        queueMicrotask(() => {
                          const focusWithinTabs = Object.values(tabRefs.current).some(
                            (node) => node === document.activeElement
                          )
                          if (!focusWithinTabs) focusedTabIdRef.current = null
                        })
                      }}
                      onKeyDown={(event) => handleTabKeyDown(event, index)}
                      className="flex shrink-0 items-center gap-1.5 px-2.5 py-2 text-[11px]"
                      style={{
                        color: selected ? theme.text.accent : theme.text.muted,
                        background: 'none',
                        border: 'none',
                        borderBottom: `2px solid ${selected ? theme.text.accent : 'transparent'}`,
                        cursor: 'default',
                        fontFamily: theme.font.ui
                      }}
                    >
                      <span className="font-semibold">{codeName}</span>
                      {codeName !== agent.agentName ? (
                        <span style={{ color: theme.text.placeholder }}>{agent.agentName}</span>
                      ) : null}
                    </button>
                  )
                })}
              </div>
            ) : (
              <div className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2">
                <span className="text-[11px] font-semibold" style={{ color: theme.text.accent }}>
                  {selectedAgent.codeName ?? selectedAgent.agentName}
                </span>
                {selectedAgent.codeName && selectedAgent.codeName !== selectedAgent.agentName ? (
                  <span className="truncate text-[11px]" style={{ color: theme.text.muted }}>
                    {selectedAgent.agentName}
                  </span>
                ) : null}
              </div>
            )}
            <div
              className="flex shrink-0 items-center gap-1 px-3 text-[10px]"
              style={{ color: theme.text.muted }}
            >
              <Clock size={10} />
              <span>{formatDurationMs(elapsed)}</span>
            </div>
          </div>

          <div
            id={`${indicatorId}-panel`}
            role={agents.length > 1 ? 'tabpanel' : undefined}
            aria-labelledby={
              agents.length > 1 ? `${indicatorId}-tab-${agents.indexOf(selectedAgent)}` : undefined
            }
          >
            <AgentPanel key={selectedAgent.delegationId} agent={selectedAgent} />
          </div>
        </div>
      ) : null}
    </div>
  )
}
