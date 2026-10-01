import { tool, type Tool } from 'ai'
import { z } from 'zod'

import type {
  AgentMessageReceipt,
  SendAgentMessageInput,
  SteerTaskToolCallDetails
} from '@yachiyo/shared/protocol'
import { textContent, toToolModelOutput, type AgentToolResult } from './shared.ts'

const taskIdSchema = z
  .string()
  .trim()
  .min(1)
  .describe('The exact delegated Task ID. Only action "steer" accepts "parent".')

const inputSchema = z
  .object({
    taskId: taskIdSchema,
    action: z
      .enum(['steer', 'eliminate'])
      .optional()
      .describe('Queue a message (default), or immediately cancel the task.'),
    message: z
      .string()
      .trim()
      .min(1)
      .max(8_000)
      .optional()
      .describe('Required for steer; not needed for eliminate.')
  })
  .superRefine((input, context) => {
    if (input.action !== 'eliminate' && !input.message) {
      context.addIssue({
        code: 'custom',
        path: ['message'],
        message: 'A message is required for steer.'
      })
    }
  })

export type SteerTaskToolInput = z.infer<typeof inputSchema>
export type SteerTaskToolOutput = AgentToolResult<SteerTaskToolCallDetails>

export interface SteerTaskContext {
  dispatch: (input: SendAgentMessageInput) => AgentMessageReceipt
  eliminate: (taskId: string) => boolean
}

export function createSteerTaskTool(
  context: SteerTaskContext
): Tool<SteerTaskToolInput, SteerTaskToolOutput> {
  return tool({
    description:
      'Control a running or idle delegated task. Set action to "eliminate" to cancel a same-team task immediately, including a hung Worker; this aborts its execution rather than queueing a message and cannot be resumed. Elimination requires an exact Task ID, not "parent" or your own ID. Omit action or use "steer" to queue a message. Use the exact Task ID returned by delegateTask. Workers may use "parent" or an exact peer Task ID. An idle task wakes with its existing history; a running task reads the steer at a safe boundary. The receipt confirms queueing, not reading or completion.',
    inputSchema,
    toModelOutput: ({ output }) => toToolModelOutput(output),
    execute: (input): SteerTaskToolOutput => {
      if (input.action === 'eliminate') {
        const cancelled = context.eliminate(input.taskId)
        const error = cancelled
          ? undefined
          : `Task "${input.taskId}" was not found, is not accessible, or cannot be eliminated (terminal, parent, or self).`
        return {
          content: textContent(
            error ?? `Task ${input.taskId} was cancelled. It cannot be resumed.`
          ),
          ...(error ? { error } : {}),
          details: { kind: 'steerTask', action: 'eliminate', taskId: input.taskId, cancelled },
          metadata: {}
        }
      }
      const receipt = context.dispatch({ to: input.taskId, message: input.message! })
      const details: SteerTaskToolCallDetails = {
        kind: 'steerTask',
        messageId: receipt.messageId,
        taskId: input.taskId,
        delivery: receipt.delivery,
        recipientState: receipt.recipientState
      }
      return {
        content: textContent(
          `Steer ${receipt.messageId} queued for task ${input.taskId}. Recipient state: ${receipt.recipientState}. Queued delivery does not mean the task has read or completed the steer.`
        ),
        details,
        metadata: {}
      }
    }
  })
}
