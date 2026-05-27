import { tool, type Tool } from 'ai'
import { z } from 'zod'

import type { UseSentinelToolCallDetails } from '@yachiyo/shared/protocol'
import type { ThreadSentinelManager } from '../../app/domain/sentinel/threadSentinelManager.ts'
import { textContent, toToolModelOutput, type ToolContentBlock } from './shared.ts'
import type { ThreadSentinelWakeContext } from '../../app/domain/sentinel/threadSentinelManager.ts'

const inputSchema = z
  .object({
    action: z
      .enum(['set', 'clear'])
      .describe('"set" to start a recurring check, "clear" to stop it.'),
    goal: z
      .string()
      .min(1)
      .optional()
      .describe(
        'What you want to achieve or verify during each check. Required when action is "set".'
      ),
    stopCondition: z
      .string()
      .min(1)
      .optional()
      .describe('What you are waiting for or checking for. Required when action is "set".'),
    intervalMinutes: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        'Minutes to wait before the next check. Must be at least 1. Required when action is "set".'
      )
  })
  .refine(
    (data) => {
      if (data.action === 'set') {
        return data.goal != null && data.stopCondition != null && data.intervalMinutes != null
      }
      return true
    },
    {
      message: 'When action is "set", goal, stopCondition, and intervalMinutes are required.'
    }
  )

export type UseSentinelToolInput = z.infer<typeof inputSchema>

export interface UseSentinelToolContext {
  threadId: string
  manager: ThreadSentinelManager
  wakeContext?: ThreadSentinelWakeContext
}

export interface UseSentinelToolOutput {
  content: ToolContentBlock[]
  details: UseSentinelToolCallDetails
  metadata: Record<string, never>
  error?: string
}

export function createUseSentinelTool(
  context: UseSentinelToolContext
): Tool<UseSentinelToolInput, UseSentinelToolOutput> {
  return tool({
    description:
      'Schedule a temporary, conversation-level recurring check. Use this when the user asks you to wait for something, check on progress later, or come back to a task after some time. ' +
      "This is different from Yachiyo's cron-based Schedules system, which is configured by the user outside the conversation. " +
      'Call action "set" with three things: a goal, a stopCondition, and intervalMinutes. ' +
      'intervalMinutes is how many minutes to wait before the next check. If the user says "check again in 5 minutes", set intervalMinutes to 5. It is not a total duration or countdown. ' +
      'The system will automatically start a new run in this conversation after each interval to evaluate the stopCondition. ' +
      'If the stopCondition is met, call action "clear" to stop the recurring checks. ' +
      'If it is not met, continue working toward the goal. You do not need to call this tool again to keep it active — after the run ends, the next check will be scheduled automatically.',
    inputSchema,
    toModelOutput: ({ output }) => toToolModelOutput(output),
    execute: async (input): Promise<UseSentinelToolOutput> => {
      if (input.action === 'clear') {
        const cleared = context.manager.clear(context.threadId)
        return {
          content: textContent(
            cleared ? 'Sentinel cleared.' : 'No sentinel was active for this conversation.'
          ),
          details: { action: 'clear' },
          metadata: {}
        }
      }

      const { goal, stopCondition, intervalMinutes } = input
      if (!goal || !stopCondition || !intervalMinutes) {
        return {
          content: textContent('Missing required fields for action "set".'),
          details: { action: 'set' },
          metadata: {},
          error: 'Missing required fields for action "set".'
        }
      }

      try {
        const sentinel = context.manager.set({
          threadId: context.threadId,
          goal,
          stopCondition,
          intervalMinutes,
          wakeContext: context.wakeContext
        })
        return {
          content: textContent(
            `Sentinel set. After this run ends, the next check will be scheduled every ${sentinel.intervalMinutes} minute${sentinel.intervalMinutes === 1 ? '' : 's'}.`
          ),
          details: {
            action: 'set',
            intervalMinutes: sentinel.intervalMinutes,
            nextRunAt: sentinel.nextRunAt
          },
          metadata: {}
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to update sentinel.'
        return {
          content: textContent(message),
          details: { action: 'set' },
          metadata: {},
          error: message
        }
      }
    }
  })
}
