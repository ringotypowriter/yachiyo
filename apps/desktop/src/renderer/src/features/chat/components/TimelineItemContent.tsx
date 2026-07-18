import React, { memo } from 'react'
import { tPlural } from '@yachiyo/i18n/index'
import { useT } from '@yachiyo/i18n/react'
import {
  isPlanDocumentMessage,
  isPlanModeExitRecord,
  PLAN_MODE_EXIT_TOOL_NAME,
  stripPlanDocumentMarker
} from '@yachiyo/shared/planMode'
import { getThreadCapabilities, type AcceptThreadPlanDocumentMode } from '@yachiyo/shared/protocol'
import { theme } from '@renderer/theme/theme'
import { makeRunningPlaceholderSeed } from '@renderer/lib/runningPlaceholders.ts'
import {
  type PlanDocumentState,
  type SubagentFinishedResult
} from '@renderer/app/store/useAppStore'
import type { RunRecord, ToolCall } from '@renderer/app/types'
import { type InlineCodeFileLinkSnapshot } from '@renderer/lib/markdown/inlineCodeFileLinkSnapshot'
import { isActiveRequestForGroup } from '../lib/timeline/messageThreadPresentation'
import {
  canCreateBranch,
  canDeleteMessage,
  canEditUserMessage,
  canRetryAssistantMessage,
  canSelectReplyBranch,
  resolveRetryTargetMessageId
} from '../lib/messages/messageActionState'
import type { MessageTimelineRow } from '../lib/timeline/messageTimelineRows.ts'
import { UserMessageBubble } from './UserMessageBubble'
import { AssistantMessageBubble } from './AssistantMessageBubble'
import { HandoffFoldMarker } from './HandoffFoldMarker'
import { HandoffSummaryRow } from './HandoffSummaryRow'
import { GeneratingRow } from './GeneratingRow'
import { SubagentRunningIndicator } from './SubagentRunningIndicator'
import { SubagentFinishedToolCallRow } from './SubagentFinishedToolCallRow'
import { PreparingBubble } from './PreparingBubble'
import { RunMemoryRecallRow } from './RunMemoryRecallRow'
import { ReplyBranchNavigation } from './ReplyBranchNavigation'
import { ToolCallRow } from './ToolCallRow'
import { ToolCallGroupRow } from './ToolCallGroupRow'
import { ThinkingBlock } from './ThinkingBlock'
import { AgentWorkSummaryRow } from './AgentWorkSummaryRow'
import { MessageActionBar } from './MessageActionBar'
import { RunStatsFooter } from './RunStatsFooter'
import { PlanDocumentCard } from './PlanDocumentCard'
import { PlanDocumentTimelineCard } from './PlanDocumentTimelineCard'

export interface TimelineItemRenderContext {
  threadCapabilities: ReturnType<typeof getThreadCapabilities> | null
  threadHasActiveRun: boolean
  threadIsSaving: boolean
  activeRequestMessageId: string | null
  activeSubagents: Array<{
    delegationId: string
    agentName: string
    agentType?: string
    codeName?: string
    prompt?: string
    progress: string
    startedAt?: string
    recentToolCalls?: Array<{
      toolCallId?: string
      toolName: string
      inputSummary: string
      outputSummary?: string
      status?: 'running' | 'completed' | 'failed'
    }>
  }>
  subagentFinishedResults: SubagentFinishedResult[]
  subagentProgressEntries: Array<{
    delegationId: string
    agentName: string
    agentType?: string
    chunk: string
  }>
  retryInfo?: { attempt: number; maxAttempts: number; error: string }
  runs: RunRecord[]
  toolCalls: ToolCall[]
  planDocument: PlanDocumentState | null
  threadId: string | null
  workspacePath?: string
  inlineCodeFileLinks: InlineCodeFileLinkSnapshot
  cancelRunForThread: (threadId: string) => Promise<void>
  revertPendingSteer: () => Promise<void>
  acceptPlanDocument: (threadId: string, mode: AcceptThreadPlanDocumentMode) => Promise<void>
  rejectPlanDocument: (threadId: string) => Promise<void>
  onEdit: (messageId: string) => void
  onCreateBranch: (messageId: string) => Promise<void>
  onBranchFromAskUser: (toolCall: ToolCall) => Promise<void>
  onRetry: (messageId: string) => Promise<void>
  onDelete: (messageId: string) => Promise<void>
  onSelectReplyBranch: (messageId: string) => Promise<void>
  onToggleHandoffFold: (foldKey: string) => void
}

interface TimelineItemContentProps {
  item: MessageTimelineRow
  context: TimelineItemRenderContext
}

function renderPlanDocumentTimelineCard(
  context: TimelineItemRenderContext
): React.JSX.Element | null {
  return (
    <PlanDocumentTimelineCard
      planDocument={context.planDocument}
      threadId={context.threadId}
      inlineCodeFileLinks={context.inlineCodeFileLinks}
      onAcceptPlanDocument={context.acceptPlanDocument}
      onRejectPlanDocument={context.rejectPlanDocument}
    />
  )
}

function renderTimelineItem(
  item: MessageTimelineRow,
  context: TimelineItemRenderContext,
  t: ReturnType<typeof useT>
): React.JSX.Element | null {
  const {
    threadCapabilities,
    threadHasActiveRun,
    threadIsSaving,
    activeRequestMessageId,
    activeSubagents,
    subagentFinishedResults,
    subagentProgressEntries,
    retryInfo,
    runs,
    toolCalls,
    threadId,
    workspacePath,
    inlineCodeFileLinks,
    cancelRunForThread,
    revertPendingSteer,
    onEdit,
    onCreateBranch,
    onBranchFromAskUser,
    onRetry,
    onDelete,
    onSelectReplyBranch,
    onToggleHandoffFold
  } = context

  if (item.kind === 'handoff-fold') {
    return (
      <HandoffFoldMarker
        foldKey={item.key}
        expanded={item.expanded}
        foldedMessageCount={item.foldedMessageCount}
        onToggle={() => onToggleHandoffFold(item.key)}
      />
    )
  }

  if (item.kind === 'handoff-summary') {
    return <HandoffSummaryRow content={item.content} />
  }

  if (item.kind === 'pending-steer') {
    if (!threadCapabilities) return null
    return (
      <div data-message-id={item.key}>
        <UserMessageBubble
          label={t('chat.timeline.pendingSteer')}
          pending
          message={item.data}
          threadHasActiveRun
          threadCapabilities={threadCapabilities}
          onRetry={() => undefined}
          onCreateBranch={() => undefined}
          onDelete={() => undefined}
          onRevert={() => void revertPendingSteer()}
        />
      </div>
    )
  }

  if (item.kind === 'tool') {
    if (item.data.toolName === PLAN_MODE_EXIT_TOOL_NAME) {
      return renderPlanDocumentTimelineCard(context)
    }

    const subagentResult = subagentFinishedResults.find(
      (result) => result.delegationId === item.data.id
    )
    if (subagentResult) {
      return <SubagentFinishedToolCallRow result={subagentResult} />
    }

    return <ToolCallRow toolCall={item.data} workspacePath={workspacePath} />
  }

  if (item.kind === 'assistant-root') {
    if (item.data.status === 'streaming' && !item.data.content.trim()) {
      return (
        <div data-message-id={item.key}>
          {item.data.reasoning ? (
            <ThinkingBlock
              reasoning={item.data.reasoning}
              isActive={true}
              startedAt={item.data.createdAt}
            />
          ) : null}
          <div className="message-response-cluster">
            <div className="message-response-cluster__preparing">
              <PreparingBubble />
            </div>
          </div>
        </div>
      )
    }

    if (isPlanModeExitRecord(item.data)) {
      return renderPlanDocumentTimelineCard(context)
    }

    return (
      <div data-message-id={item.key}>
        {item.data.reasoning ? (
          <ThinkingBlock
            reasoning={item.data.reasoning}
            isActive={item.data.status === 'streaming'}
            startedAt={item.data.createdAt}
          />
        ) : null}
        {isPlanDocumentMessage(item.data.content) ? (
          <PlanDocumentCard
            content={stripPlanDocumentMarker(item.data.content)}
            decision="accepted"
            defaultExpanded={false}
            inlineCodeFileLinks={inlineCodeFileLinks}
          />
        ) : (
          <AssistantMessageBubble
            message={item.data}
            inlineCodeFileLinks={inlineCodeFileLinks}
            workspacePath={workspacePath}
          />
        )}
      </div>
    )
  }

  if (!threadCapabilities) return null

  const group = item.group
  const responseCount = group.assistantBranches.length
  const activeBranch =
    group.activeBranchIndex >= 0 ? group.assistantBranches[group.activeBranchIndex] : null
  const previousBranch =
    group.activeBranchIndex > 0 ? group.assistantBranches[group.activeBranchIndex - 1] : null
  const nextBranch =
    group.activeBranchIndex >= 0 && group.activeBranchIndex < responseCount - 1
      ? group.assistantBranches[group.activeBranchIndex + 1]
      : null
  const retryTargetMessageId = resolveRetryTargetMessageId({
    userMessageId: group.userMessage.id,
    ...(activeBranch ? { activeAssistantMessage: activeBranch.message } : {})
  })
  const canBranchMessages = canCreateBranch({
    threadCapabilities,
    threadHasActiveRun,
    threadIsSaving
  })
  const canEditMessages = canEditUserMessage({
    threadCapabilities,
    threadHasActiveRun,
    threadIsSaving
  })
  const canDeleteMessages = canDeleteMessage({
    threadCapabilities,
    threadHasActiveRun,
    threadIsSaving
  })
  const canSwitchReplyBranches = canSelectReplyBranch({
    threadCapabilities,
    threadHasActiveRun,
    threadIsSaving
  })
  const isActiveGroup =
    'group' in item && isActiveRequestForGroup(item.group, activeRequestMessageId)
  const groupRetryInfo = isActiveGroup ? retryInfo : undefined
  const cancelSubagent =
    isActiveGroup && activeSubagents.length === 1 && threadId
      ? () => void cancelRunForThread(threadId)
      : undefined

  if (item.kind === 'group-user') {
    return (
      <div data-message-id={group.userMessage.id}>
        <UserMessageBubble
          message={group.userMessage}
          threadHasActiveRun={threadHasActiveRun}
          threadCapabilities={threadCapabilities}
          threadIsSaving={threadIsSaving}
          onEdit={canEditMessages ? () => onEdit(group.userMessage.id) : undefined}
          onRetry={threadCapabilities.canRetry ? () => onRetry(retryTargetMessageId) : undefined}
          onCreateBranch={
            canBranchMessages ? () => onCreateBranch(group.userMessage.id) : undefined
          }
          onDelete={canDeleteMessages ? () => onDelete(group.userMessage.id) : undefined}
        />
      </div>
    )
  }

  if (item.kind === 'group-branch-navigation') {
    return (
      <div className="px-6 py-0.5">
        <ReplyBranchNavigation
          replyCount={responseCount}
          canSelectPreviousReply={canSwitchReplyBranches && Boolean(previousBranch)}
          canSelectNextReply={canSwitchReplyBranches && Boolean(nextBranch)}
          onSelectPreviousReply={
            canSwitchReplyBranches && previousBranch
              ? () => void onSelectReplyBranch(previousBranch.message.id)
              : undefined
          }
          onSelectNextReply={
            canSwitchReplyBranches && nextBranch
              ? () => void onSelectReplyBranch(nextBranch.message.id)
              : undefined
          }
        />
      </div>
    )
  }

  if (item.kind === 'group-thinking') {
    return (
      <div {...(item.scrollMessageId ? { 'data-message-id': item.scrollMessageId } : {})}>
        <ThinkingBlock
          reasoning={item.reasoning}
          isActive={item.isActive}
          startedAt={item.startedAt}
        />
      </div>
    )
  }

  if (item.kind === 'group-memory-recall') {
    return <RunMemoryRecallRow entries={item.entries} recallDecision={item.recallDecision} />
  }

  if (item.kind === 'group-work-summary') {
    const toolCallsInSummary = item.items.flatMap((trajectoryItem) => {
      if (trajectoryItem.kind === 'tool-call') return [trajectoryItem.toolCall]
      if (trajectoryItem.kind === 'tool-call-group') return trajectoryItem.toolCalls
      return []
    })

    return (
      <AgentWorkSummaryRow
        items={item.items}
        requestMessageIds={item.requestMessageIds}
        runs={runs}
        toolCalls={toolCallsInSummary}
        workspacePath={workspacePath}
        onBranchFromAskUser={
          canBranchMessages ? (toolCall) => void onBranchFromAskUser(toolCall) : undefined
        }
      />
    )
  }
  if (item.kind === 'group-tool-call') {
    const subagentResult = subagentFinishedResults.find(
      (result) => result.delegationId === item.toolCall.id
    )
    if (subagentResult) {
      return <SubagentFinishedToolCallRow result={subagentResult} />
    }

    return <ToolCallRow toolCall={item.toolCall} workspacePath={workspacePath} />
  }
  if (item.kind === 'group-tool-call-group') {
    return (
      <ToolCallGroupRow
        group={item.toolGroup}
        toolCalls={item.toolCalls}
        workspacePath={workspacePath}
      />
    )
  }

  if (item.kind === 'group-assistant-text-block') {
    return (
      <div className="message-response-cluster" data-message-id={item.assistantMessage.id}>
        <AssistantMessageBubble
          message={item.assistantMessage}
          contentOverride={item.textBlock.content}
          showFooter={false}
          inlineCodeFileLinks={inlineCodeFileLinks}
          workspacePath={workspacePath}
          suppressGeneratingLabel={
            item.hasRunningToolCall || item.assistantMessage.status === 'streaming'
          }
          pauseStreaming={!item.isStreaming}
          showCaret={item.isStreaming}
          compactBottomSpacing={item.compactBottomSpacing}
        />
      </div>
    )
  }

  if (item.kind === 'group-plan-document') {
    return renderPlanDocumentTimelineCard(context)
  }

  if (item.kind === 'group-generating') {
    const seed = makeRunningPlaceholderSeed(item.activeRunId, context.threadId ?? '', item.state)
    return <GeneratingRow retryInfo={groupRetryInfo} state={item.state} seed={seed} />
  }

  if (item.kind === 'group-preparing') {
    if (groupRetryInfo) {
      return <GeneratingRow retryInfo={groupRetryInfo} />
    }

    return (
      <div className="message-response-cluster">
        <div className="message-response-cluster__preparing">
          <PreparingBubble />
        </div>
      </div>
    )
  }

  if (item.kind === 'group-footer') {
    return (
      <div className="message-bubble-group px-6 py-1 flex flex-col gap-0.5">
        {item.assistantMessage.status === 'stopped' ? (
          <div className="message-footer message-footer--always-visible">
            {t('chat.timeline.stopped')}
          </div>
        ) : item.assistantMessage.status === 'failed' ? (
          <div
            className="message-footer message-footer--always-visible"
            style={{ color: theme.text.danger }}
          >
            {item.failedRunError
              ? t('chat.timeline.failedWithError', { error: item.failedRunError })
              : t('chat.timeline.failedToGenerate')}
          </div>
        ) : null}
        {item.savedMemoryCount > 0 ? (
          <div
            className="message-footer message-footer--always-visible inline-flex items-center gap-1"
            style={{ color: theme.text.accent }}
          >
            {tPlural('chat.timeline.memoriesSaved', item.savedMemoryCount)}
          </div>
        ) : null}
        {item.showRunStats ? (
          <RunStatsFooter
            runs={runs}
            toolCalls={toolCalls}
            requestMessageIds={[item.requestMessageId, ...item.group.hiddenRequestMessageIds]}
          />
        ) : null}
        <MessageActionBar
          align="start"
          content={item.assistantMessage.content}
          canRetry={canRetryAssistantMessage({
            messageStatus: item.assistantMessage.status,
            threadCapabilities,
            threadHasActiveRun,
            threadIsSaving
          })}
          onRetry={
            threadCapabilities.canRetry ? () => onRetry(item.assistantMessage.id) : undefined
          }
          onCreateBranch={
            canCreateBranch({
              messageStatus: item.assistantMessage.status,
              threadCapabilities,
              threadHasActiveRun,
              threadIsSaving
            })
              ? () => onCreateBranch(item.assistantMessage.id)
              : undefined
          }
          onDelete={canDeleteMessages ? () => onDelete(item.assistantMessage.id) : undefined}
        />
      </div>
    )
  }

  if (item.kind === 'group-subagent') {
    return (
      <SubagentRunningIndicator
        agents={activeSubagents}
        progressEntries={subagentProgressEntries}
        onCancel={cancelSubagent}
      />
    )
  }

  return null
}

function TimelineItemContentBase({
  item,
  context
}: TimelineItemContentProps): React.JSX.Element | null {
  const t = useT()
  return renderTimelineItem(item, context, t)
}

export const TimelineItemContent = memo(
  TimelineItemContentBase,
  (prev, next) => prev.item === next.item && prev.context === next.context
)
