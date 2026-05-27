import { tool, type Tool } from 'ai'
import { z } from 'zod'

export const planExitToolInputSchema = z.object({
  ready: z.boolean().optional().describe('Optional confirmation that the plan document is ready.')
})
export type PlanExitToolInput = z.infer<typeof planExitToolInputSchema>
export interface PlanExitToolOutput {
  content: string
}

export function createPlanExitTool(): Tool<PlanExitToolInput, PlanExitToolOutput> {
  return tool<PlanExitToolInput, PlanExitToolOutput>({
    description:
      'Exit Plan Mode after the plan document has been written. Call this tool instead of replying with text when the plan is ready for user review.',
    inputSchema: planExitToolInputSchema,
    toModelOutput: ({ output }) => ({
      type: 'content',
      value: [{ type: 'text', text: output.content }]
    }),
    execute: async () => ({
      content: 'Plan Mode exited. The UI will display the current plan document.'
    })
  })
}
