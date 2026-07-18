import { tool, type Tool } from 'ai'

import { z } from 'zod'

import type { AskUserToolCallDetails } from '@yachiyo/shared/protocol'
import { textContent, toToolModelOutput, type AgentToolResult } from './shared.ts'

export const ASK_USER_MAX_QUESTION_CHARS = 280
export const ASK_USER_MAX_CHOICE_CHARS = 120
export const ASK_USER_MAX_CHOICES = 8

export const askUserToolInputSchema = z.object({
  question: z
    .string()
    .trim()
    .min(1)
    .max(ASK_USER_MAX_QUESTION_CHARS)
    .describe(
      'One short, direct question for the user. Do not include analysis, a plan, a proposal, lists, or background.'
    ),
  choices: z
    .array(z.string().trim().min(1).max(ASK_USER_MAX_CHOICE_CHARS))
    .min(2)
    .max(ASK_USER_MAX_CHOICES)
    .optional()
    .describe(
      'Optional 2-8 short answer choices for the user to pick from. Prefer concrete, finished choices instead of placeholder labels.'
    )
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

export function createAskUserTool(
  ctx: AskUserToolContext
): Tool<AskUserToolInput, AskUserToolOutput> {
  return tool({
    description:
      'Ask exactly one short question and wait for the user answer. ' +
      'Use only when user input is required to continue. ' +
      `The question must be under ${ASK_USER_MAX_QUESTION_CHARS} characters and must not contain analysis, implementation plans, proposals, lists, or background. ` +
      'When quick-pick answers help, provide 2-8 short `choices` so the user can answer quickly. ' +
      'Choices should be concrete, finished answers; avoid placeholder labels, ellipses, or unfinished text. ' +
      'Do not use for rhetorical questions or when you can reasonably infer the answer.',
    inputSchema: askUserToolInputSchema,
    toModelOutput: ({ output }) => toToolModelOutput(output),
    execute: async (input, { toolCallId }): Promise<AskUserToolOutput> => {
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
