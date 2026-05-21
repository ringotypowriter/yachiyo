import { resolve } from 'node:path'

import type {
  AcceptThreadPlanDocumentInput,
  ChatAccepted,
  MessageCompletedEvent,
  MessageRecord,
  ReadThreadPlanDocumentResult,
  ThreadRecord,
  ThreadUpdatedEvent
} from '../../../../shared/yachiyo/protocol.ts'
import { DEFAULT_ENABLED_TOOL_NAMES } from '../../../../shared/yachiyo/protocol.ts'
import { summarizeMessagePreview } from '../../../../shared/yachiyo/messageContent.ts'
import { PLAN_DOCUMENT_MARKER } from '../../../../shared/yachiyo/planMode.ts'
import type { YachiyoStorage } from '../../storage/storage.ts'
import type { FolderDomain } from '../domain/folders/folderDomain.ts'
import type { YachiyoServerRunDomain } from '../domain/run/runDomain.ts'
import type { YachiyoServerThreadDomain } from '../domain/threads/threadDomain.ts'
import { isDefaultNewChatThread } from './takeoverContext.ts'

const PLAN_EXECUTION_USER_MESSAGE = 'Execute the accepted plan.'

type PlanAcceptanceMode = NonNullable<AcceptThreadPlanDocumentInput['mode']>
type PlanAcceptanceEvent = MessageCompletedEvent | ThreadUpdatedEvent

function stripMarkdownInline(value: string): string {
  return value
    .replace(/[`*_~]/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .trim()
}

function derivePlanExecutionThreadTitle(planContent: string, sourceThread: ThreadRecord): string {
  const heading = planContent
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /^#{1,3}\s+\S/.test(line))

  const planTitle = heading ? stripMarkdownInline(heading.replace(/^#{1,3}\s+/, '')) : ''
  if (planTitle) return planTitle.slice(0, 80)

  const sourceTitle = sourceThread.title.trim()
  if (sourceTitle && !isDefaultNewChatThread(sourceThread)) return sourceTitle.slice(0, 80)

  return 'Accepted Plan'
}

export function resolvePlanAcceptanceMode(
  mode: AcceptThreadPlanDocumentInput['mode']
): PlanAcceptanceMode {
  return mode === 'direct' ? 'direct' : 'handoff'
}

export function getPlanAcceptanceKey(
  plan: ReadThreadPlanDocumentResult,
  mode: PlanAcceptanceMode
): string {
  return `${mode}\u0000${plan.path}\u0000${plan.content}`
}

function seedAcceptedPlanMessage(input: {
  createId: () => string
  emit: <TEvent extends PlanAcceptanceEvent>(event: Omit<TEvent, 'eventId' | 'timestamp'>) => void
  hidden: boolean
  plan: ReadThreadPlanDocumentResult
  storage: YachiyoStorage
  thread: ThreadRecord
  timestamp: () => string
}): { thread: ThreadRecord; message: MessageRecord } {
  const timestamp = input.timestamp()
  const planMessage: MessageRecord = {
    id: input.createId(),
    threadId: input.thread.id,
    role: 'assistant',
    content: `${PLAN_DOCUMENT_MARKER}\n${input.plan.content}`,
    status: 'completed',
    createdAt: timestamp,
    ...(input.hidden ? { hidden: true } : {})
  }

  const updatedThread: ThreadRecord = {
    ...input.thread,
    headMessageId: planMessage.id,
    ...(input.hidden
      ? {}
      : {
          preview: summarizeMessagePreview({ ...planMessage, content: input.plan.content }).slice(
            0,
            240
          )
        }),
    updatedAt: timestamp
  }

  input.storage.saveThreadMessage({
    thread: input.thread,
    updatedThread,
    message: planMessage
  })

  input.emit<MessageCompletedEvent>({
    type: 'message.completed',
    threadId: input.thread.id,
    runId: planMessage.id,
    message: planMessage
  })

  input.emit<ThreadUpdatedEvent>({
    type: 'thread.updated',
    threadId: input.thread.id,
    thread: updatedThread
  })

  return { thread: updatedThread, message: planMessage }
}

async function startPlanAcceptanceDirect(input: PlanAcceptanceInput): Promise<ChatAccepted> {
  const toolEnabledThread = input.threadDomain.setThreadToolMode({
    threadId: input.sourceThread.id,
    enabledTools: DEFAULT_ENABLED_TOOL_NAMES
  })
  const seeded = seedAcceptedPlanMessage({
    ...input,
    hidden: false,
    thread: toolEnabledThread
  })

  return input.runDomain.sendChat({
    threadId: seeded.thread.id,
    enabledTools: DEFAULT_ENABLED_TOOL_NAMES,
    runMode: 'auto',
    hidden: false,
    content: PLAN_EXECUTION_USER_MESSAGE
  })
}

async function startPlanAcceptanceWithHandoff(input: PlanAcceptanceInput): Promise<ChatAccepted> {
  const destinationThread = await input.threadDomain.createThread({
    threadId: input.createId(),
    title: derivePlanExecutionThreadTitle(input.plan.content, input.sourceThread),
    ...(input.sourceThread.icon ? { icon: input.sourceThread.icon } : {}),
    handoffFromThreadId: input.sourceThread.id,
    enabledTools: DEFAULT_ENABLED_TOOL_NAMES,
    workspacePath: input.sourceThread.workspacePath?.trim()
      ? resolve(input.sourceThread.workspacePath)
      : input.resolveThreadWorkspacePath(input.sourceThread.id),
    ...(input.sourceThread.modelOverride
      ? { modelOverride: input.sourceThread.modelOverride }
      : {}),
    ...(input.sourceThread.reasoningEffort
      ? { reasoningEffort: input.sourceThread.reasoningEffort }
      : {})
  })

  input.folderDomain.ensureFolderForDerivedThread({
    sourceThread: input.sourceThread,
    derivedThread: destinationThread
  })

  const seeded = seedAcceptedPlanMessage({
    ...input,
    hidden: false,
    thread: destinationThread
  })

  return input.runDomain.sendChat({
    threadId: seeded.thread.id,
    enabledTools: DEFAULT_ENABLED_TOOL_NAMES,
    runMode: 'auto',
    hidden: false,
    content: PLAN_EXECUTION_USER_MESSAGE
  })
}

export interface PlanAcceptanceInput {
  createId: () => string
  emit: <TEvent extends PlanAcceptanceEvent>(event: Omit<TEvent, 'eventId' | 'timestamp'>) => void
  folderDomain: FolderDomain
  mode: PlanAcceptanceMode
  plan: ReadThreadPlanDocumentResult
  resolveThreadWorkspacePath: (threadId: string) => string
  runDomain: YachiyoServerRunDomain
  sourceThread: ThreadRecord
  storage: YachiyoStorage
  threadDomain: YachiyoServerThreadDomain
  timestamp: () => string
}

export function startPlanAcceptance(input: PlanAcceptanceInput): Promise<ChatAccepted> {
  return input.mode === 'direct'
    ? startPlanAcceptanceDirect(input)
    : startPlanAcceptanceWithHandoff(input)
}
