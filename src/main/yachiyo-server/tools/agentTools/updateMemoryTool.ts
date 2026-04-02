import { tool, type Tool } from 'ai'
import { z } from 'zod'

import type { MemoryService } from '../../services/memory/memoryService.ts'
import type { UserDocumentMode } from '../../runtime/user.ts'
import { patchUserDocumentSection, writeUserDocument } from '../../runtime/user.ts'

const FULL_UPDATE_MEMORY_MODES = ['profile', 'profile-section', 'memory'] as const
const PARTIAL_UPDATE_MEMORY_MODES = ['profile-section', 'memory'] as const

interface UpdateMemoryToolInput {
  mode: (typeof FULL_UPDATE_MEMORY_MODES)[number]
  section?: string
  content: string
}

interface UpdateMemoryToolOutput {
  content: Array<{ type: 'text'; text: string }>
  error?: string
}

export interface UpdateMemoryDeps {
  memoryService: MemoryService
  /** Absolute path to the guest's workspace USER.md. */
  userDocumentPath: string
  /** Template mode used when a broken USER.md needs to be rebuilt before patching. */
  userDocumentMode?: UserDocumentMode
  /** When true, mode "profile" (full rewrite) is rejected at execution time. */
  rejectFullRewrite?: boolean
}

function createUpdateMemoryToolInputSchema(
  rejectFullRewrite: boolean
): z.ZodType<UpdateMemoryToolInput> {
  const modes = rejectFullRewrite ? PARTIAL_UPDATE_MEMORY_MODES : FULL_UPDATE_MEMORY_MODES

  return z
    .object({
      mode: z.enum(modes),
      /** Required when mode is "profile-section": the `## Heading` name to patch. */
      section: z.string().optional(),
      content: z.string().min(1)
    })
    .refine((v) => v.mode !== 'profile-section' || (v.section && v.section.trim().length > 0), {
      message: 'section is required when mode is profile-section',
      path: ['section']
    })
}

function buildUpdateMemoryToolDescription(rejectFullRewrite: boolean): string {
  const lines = [
    'Save observations about the current user or conversation.',
    'mode "profile-section": Patch a single ## Section in USER.md without touching other sections.',
    rejectFullRewrite
      ? '  Requires `section` (e.g. "People", "Group Vibe", or "Topic Hints"). Use this whenever you only want to update part of the file.'
      : '  Requires `section` (the exact heading name from USER.md). Use this instead of "profile" whenever you only want to update part of the file.',
    'mode "memory": Save a fact or observation to long-term memory (works only when memory is configured).'
  ]

  if (!rejectFullRewrite) {
    lines.splice(
      1,
      0,
      'mode "profile": Overwrite the entire USER.md with durable understanding of this person.'
    )
  }

  return lines.join(' ')
}

export function createTool(
  deps: UpdateMemoryDeps
): Tool<UpdateMemoryToolInput, UpdateMemoryToolOutput> {
  const rejectFullRewrite = deps.rejectFullRewrite ?? false

  return tool({
    description: buildUpdateMemoryToolDescription(rejectFullRewrite),
    inputSchema: createUpdateMemoryToolInputSchema(rejectFullRewrite),
    toModelOutput: ({ output }) =>
      output.error
        ? { type: 'error-text', value: output.error }
        : { type: 'content', value: output.content },
    execute: async (input) => {
      try {
        if (input.mode === 'profile') {
          if (rejectFullRewrite) {
            return {
              content: [
                {
                  type: 'text',
                  text: 'Full profile rewrite is not allowed in this context. Use mode "profile-section" with a section name to update a specific section.'
                }
              ],
              error:
                'Full profile rewrite rejected. Use mode "profile-section" with a section name instead.'
            }
          }
          await writeUserDocument({
            filePath: deps.userDocumentPath,
            content: input.content
          })
          return {
            content: [{ type: 'text', text: 'Profile updated.' }]
          }
        }

        if (input.mode === 'profile-section') {
          await patchUserDocumentSection({
            filePath: deps.userDocumentPath,
            section: input.section!,
            content: input.content,
            mode: deps.userDocumentMode
          })
          return {
            content: [{ type: 'text', text: `Section "${input.section}" updated.` }]
          }
        }

        if (!deps.memoryService.isConfigured()) {
          return {
            content: [{ type: 'text', text: 'Memory is not configured. Observation not saved.' }],
            error: 'Memory is not configured.'
          }
        }

        const result = await deps.memoryService.createMemory({
          topic: 'channel-observation',
          title: input.content.slice(0, 80),
          content: input.content,
          unitType: 'fact'
        })

        return {
          content: [
            {
              type: 'text',
              text:
                result.savedCount > 0
                  ? 'Memory saved.'
                  : 'Memory service accepted the request but saved 0 entries.'
            }
          ]
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'updateMemory failed.'
        return {
          content: [{ type: 'text', text: message }],
          error: message
        }
      }
    }
  })
}
