import { tool, type Tool } from 'ai'
import { z } from 'zod'

import type { GetTaskToolCallDetails, SubagentSnapshot } from '@yachiyo/shared/protocol'
import { textContent, toToolModelOutput, type AgentToolResult } from './shared.ts'

const inputSchema = z.object({
  taskId: z.string().trim().min(1).describe('The exact Task ID returned by delegateTask.')
})

export type GetTaskToolInput = z.infer<typeof inputSchema>
export type GetTaskToolOutput = AgentToolResult<GetTaskToolCallDetails>

export interface GetTaskContext {
  getTask: (taskId: string) => SubagentSnapshot | undefined
}

function formatTask(snapshot: SubagentSnapshot): string {
  const lines = [
    `Task ${snapshot.agentId} (${snapshot.codeName}, ${snapshot.agentType})`,
    `State: ${snapshot.state}`,
    `Updated: ${snapshot.updatedAt}`
  ]
  if (snapshot.error) lines.push(`Error: ${snapshot.error}`)
  if (snapshot.progress?.trim()) lines.push(`Progress:\n${snapshot.progress.trim()}`)
  if (snapshot.lastOutput?.trim()) lines.push(`Last output:\n${snapshot.lastOutput.trim()}`)
  return lines.join('\n')
}

export function createGetTaskTool(
  context: GetTaskContext
): Tool<GetTaskToolInput, GetTaskToolOutput> {
  return tool({
    description:
      'Get the current state and latest progress of one delegated task. Use the exact Task ID returned by delegateTask. This is a read-only snapshot; use steerTask to continue or wake an idle task.',
    inputSchema,
    toModelOutput: ({ output }) => toToolModelOutput(output),
    execute: (input): GetTaskToolOutput => {
      const snapshot = context.getTask(input.taskId)
      if (!snapshot) {
        const error = `Task "${input.taskId}" was not found or is not accessible from this team.`
        return {
          content: textContent(error),
          error,
          details: { kind: 'getTask', taskId: input.taskId },
          metadata: {}
        }
      }

      return {
        content: textContent(formatTask(snapshot)),
        details: {
          kind: 'getTask',
          taskId: input.taskId,
          state: snapshot.state,
          updatedAt: snapshot.updatedAt
        },
        metadata: {}
      }
    }
  })
}
