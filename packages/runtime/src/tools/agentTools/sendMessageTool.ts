import { tool, type Tool } from 'ai'
import { z } from 'zod'

import type {
  AgentEndpoint,
  AgentMessageReceipt,
  SendAgentMessageInput,
  SendMessageToolCallDetails
} from '@yachiyo/shared/protocol'
import { textContent, toToolModelOutput, type AgentToolResult } from './shared.ts'

const inputSchema = z.object({
  to: z
    .string()
    .trim()
    .min(1)
    .describe('The recipient: "parent" for the parent agent, or the exact worker agent ID.'),
  message: z
    .string()
    .trim()
    .min(1)
    .max(8_000)
    .describe('The concise message to queue for the recipient.')
})

export type SendMessageToolInput = z.infer<typeof inputSchema>
export type SendMessageToolOutput = AgentToolResult<SendMessageToolCallDetails>

/**
 * The sender endpoint is bound by the caller (never supplied by model input).
 * Dispatch implementations should use it as the `from` endpoint when sending.
 */
export interface AgentMessageContext {
  sender: AgentEndpoint
  dispatch: (input: SendAgentMessageInput) => AgentMessageReceipt
}

export function createSendMessageTool(
  context: AgentMessageContext
): Tool<SendMessageToolInput, SendMessageToolOutput> {
  return tool({
    description:
      'Continue collaboration with an existing Agent by queueing it a message. Parent agents address a running or idle Worker by its exact Agent ID; this wakes an idle Worker and preserves its history. Worker agents can address "parent" or an exact peer Agent ID. The receipt confirms queueing, not reading or reply.',
    inputSchema,
    toModelOutput: ({ output }) => toToolModelOutput(output),
    execute: (input): SendMessageToolOutput => {
      const receipt = context.dispatch(input)
      const details: SendMessageToolCallDetails = {
        kind: 'sendMessage',
        messageId: receipt.messageId,
        to: input.to,
        delivery: receipt.delivery,
        recipientState: receipt.recipientState
      }
      return {
        content: textContent(
          `Message ${receipt.messageId} queued for ${input.to}. Delivery: ${receipt.delivery}; recipient state: ${receipt.recipientState}. Queued delivery does not mean the recipient has read the message or replied.`
        ),
        details,
        metadata: {}
      }
    }
  })
}
