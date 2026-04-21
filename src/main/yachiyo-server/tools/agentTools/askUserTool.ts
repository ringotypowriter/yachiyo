import { tool, type Tool } from 'ai'

import { z } from 'zod'

import type { AskUserToolCallDetails } from '../../../../shared/yachiyo/protocol.ts'
import { textContent, toToolModelOutput, type AgentToolResult } from './shared.ts'

export const askUserToolInputSchema = z.object({
  question: z
    .string()
    .min(1)
    .max(2000)
    .describe('The question to ask the user. Be specific and concise.'),
  choices: z
    .array(z.string().min(1).max(200))
    .max(6)
    .optional()
    .describe('Optional predefined answer choices for the user to pick from.')
})

export type AskUserToolInput = z.infer<typeof askUserToolInputSchema>
export type AskUserToolOutput = AgentToolResult<AskUserToolCallDetails>

export interface AskUserToolContext {
  /**
   * Called when the model invokes this tool.
   * Returns a Promise that resolves with the user's answer string.
   * The promise is rejected if the run is cancelled or times out.
   */
  waitForUserAnswer: (toolCallId: string, question: string, choices?: string[]) => Promise<string>
}

const MAX_ASK_USER_PER_RUN = 10

export function createAskUserTool(
  ctx: AskUserToolContext,
  state: { askCount: number } = { askCount: 0 }
): Tool<AskUserToolInput, AskUserToolOutput> {
  return tool({
    description:
      'Ask the user a question and wait for their answer. ' +
      'Use when you need to gather preferences or requirements, clarify ambiguous instructions, ' +
      'decide between implementation options, or offer directional choices before proceeding. ' +
      'Do not use for rhetorical questions or when you can reasonably infer the answer.',
    inputSchema: askUserToolInputSchema,
    toModelOutput: ({ output }) => toToolModelOutput(output),
    execute: async (input, { toolCallId }): Promise<AskUserToolOutput> => {
      state.askCount++

      if (state.askCount > MAX_ASK_USER_PER_RUN) {
        const details: AskUserToolCallDetails = {
          kind: 'askUser',
          question: input.question,
          choices: input.choices
        }
        return {
          content: textContent(
            'You have already asked the user multiple questions in this run. ' +
              'Please proceed with your best judgment.'
          ),
          details,
          metadata: {},
          error: 'Ask limit exceeded'
        }
      }

      const answer = await ctx.waitForUserAnswer(toolCallId, input.question, input.choices)

      const details: AskUserToolCallDetails = {
        kind: 'askUser',
        question: input.question,
        choices: input.choices,
        answer
      }

      return {
        content: textContent(answer),
        details,
        metadata: {}
      }
    }
  })
}
