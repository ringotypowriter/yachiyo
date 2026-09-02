import { tool, type Tool } from 'ai'
import { z } from 'zod'

import type {
  AgentMessageReceipt,
  SendAgentMessageInput,
  SteerTaskToolCallDetails
} from '@yachiyo/shared/protocol'
import { textContent, toToolModelOutput, type AgentToolResult } from './shared.ts'

const inputSchema = z.object({
  taskId: z
    .string()
    .trim()
    .min(1)
    .describe('The exact delegated Task ID, or "parent" when a Worker addresses its parent.'),
  message: z.string().trim().min(1).max(8_000).describe('The steer to queue for the task.')
})

export type SteerTaskToolInput = z.infer<typeof inputSchema>
export type SteerTaskToolOutput = AgentToolResult<SteerTaskToolCallDetails>

export interface SteerTaskContext {
  dispatch: (input: SendAgentMessageInput) => AgentMessageReceipt
}

export function createSteerTaskTool(
  context: SteerTaskContext
): Tool<SteerTaskToolInput, SteerTaskToolOutput> {
  return tool({
    description:
      'Steer a running or idle delegated task by queueing it a message. Use the exact Task ID returned by delegateTask. Workers may use "parent" or an exact peer Task ID. An idle task wakes with its existing history; a running task reads the steer at a safe boundary. The receipt confirms queueing, not reading or completion.',
    inputSchema,
    toModelOutput: ({ output }) => toToolModelOutput(output),
    execute: (input): SteerTaskToolOutput => {
      const receipt = context.dispatch({ to: input.taskId, message: input.message })
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
