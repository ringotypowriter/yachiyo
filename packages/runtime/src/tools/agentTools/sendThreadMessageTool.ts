import { tool, type Tool } from 'ai'
import { z } from 'zod'

import { textContent, toToolModelOutput, type ToolContentBlock } from './shared.ts'

const inputSchema = z.object({
  targetThreadId: z.string().trim().min(1).describe('The exact ID of the conversation to notify.'),
  message: z
    .string()
    .trim()
    .min(1)
    .max(8_000)
    .describe(
      'The concise message for the other conversation. Include the relevant result or request.'
    )
})

export type SendThreadMessageToolInput = z.infer<typeof inputSchema>

export interface SendThreadMessageToolContext {
  sourceThreadId: string
  dispatch: (input: { targetThreadId: string; message: string }) => Promise<{
    kind: 'run-started' | 'active-run-steer' | 'active-run-steer-pending' | 'active-run-follow-up'
    runId: string
  }>
}

export interface SendThreadMessageToolOutput {
  content: ToolContentBlock[]
  metadata: Record<string, never>
  error?: string
}

export function createSendThreadMessageTool(
  context: SendThreadMessageToolContext
): Tool<SendThreadMessageToolInput, SendThreadMessageToolOutput> {
  return tool({
    description:
      'Send an internal message to another local conversation. Use querySource first when you need to find the exact conversation ID. The recipient continues safely after its current work if it is running, or starts a new run if it is idle. Do not use this to send a message to the current conversation.',
    inputSchema,
    toModelOutput: ({ output }) => toToolModelOutput(output),
    execute: async (input): Promise<SendThreadMessageToolOutput> => {
      if (input.targetThreadId === context.sourceThreadId) {
        const error = 'Cannot send a message to the current conversation.'
        return { content: textContent(error), metadata: {}, error }
      }

      const delivery = await context.dispatch(input)
      return {
        content: textContent(
          `Message delivered to conversation ${input.targetThreadId} (${delivery.runId}).`
        ),
        metadata: {}
      }
    }
  })
}
