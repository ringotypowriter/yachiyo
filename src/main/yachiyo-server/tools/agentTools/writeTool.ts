import { tool, type Tool } from 'ai'

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { WriteToolCallDetails } from '../../../../shared/yachiyo/protocol.ts'

import {
  type AgentToolContext,
  type WriteToolInput,
  type WriteToolOutput,
  hasAccess,
  resolveToolPath,
  resolveUnicodeSpacePath,
  textContent,
  toToolModelOutput,
  writeToolInputSchema
} from './shared.ts'

export function createTool(context: AgentToolContext): Tool<WriteToolInput, WriteToolOutput> {
  return tool({
    description: `Write a text file in the current thread workspace or at an absolute path. Relative paths resolve from ${context.workspacePath}. Parent directories are created automatically and existing files are overwritten.`,
    inputSchema: writeToolInputSchema,
    toModelOutput: ({ output }) => toToolModelOutput(output),
    execute: (input) => runWriteTool(input, context)
  })
}

function createWriteResult(
  path: string,
  details: WriteToolCallDetails,
  error?: string
): WriteToolOutput {
  const action = details.overwritten ? 'Overwrote' : 'Wrote'
  const message = error ?? `${action} ${details.bytesWritten} bytes to ${path}.`

  return {
    content: textContent(message),
    details,
    ...(error ? { error } : {}),
    metadata: {}
  }
}

export async function runWriteTool(
  input: WriteToolInput,
  context: AgentToolContext
): Promise<WriteToolOutput> {
  const resolvedPath = await resolveUnicodeSpacePath(
    resolveToolPath(context.workspacePath, input.path)
  )

  try {
    const exists = await hasAccess(resolvedPath)
    await mkdir(dirname(resolvedPath), { recursive: true })
    await writeFile(resolvedPath, input.content, 'utf8')

    return createWriteResult(resolvedPath, {
      path: resolvedPath,
      bytesWritten: Buffer.byteLength(input.content, 'utf8'),
      created: !exists,
      overwritten: exists
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to write file.'
    return createWriteResult(
      resolvedPath,
      {
        path: resolvedPath,
        bytesWritten: 0,
        created: false,
        overwritten: false
      },
      message
    )
  }
}
