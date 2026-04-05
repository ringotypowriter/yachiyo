import { tool, type Tool } from 'ai'
import { z } from 'zod'

import type { UserDocumentMode } from '../../runtime/user.ts'
import { patchUserDocumentSection, readUserDocument } from '../../runtime/user.ts'
import {
  buildSectionDescriptionBlock,
  formatTimestamp,
  getCanonicalSectionName,
  getSectionSchema,
  migrateLegacyLines,
  parseTable,
  removeRows,
  removeRowsByIndex,
  renderTable,
  upsertRows,
  upsertRowsByIndex
} from '../../runtime/profileTable.ts'

const updateProfileToolInputSchema = z.object({
  section: z.string().min(1).describe('Section name from USER.md (e.g. "Profile", "People")'),
  operation: z.enum(['upsert', 'remove']),
  entries: z
    .array(z.record(z.string(), z.string()))
    .optional()
    .describe('Rows to add or update. Keys are column names from the section schema.'),
  keys: z
    .array(z.string())
    .optional()
    .describe('Key column values to remove (only for operation "remove").'),
  indices: z
    .array(z.number().int().min(0))
    .optional()
    .describe(
      'Zero-based row indices to target. For "upsert": entries[i] updates row at indices[i]. For "remove": removes rows at these positions. When provided, key column matching is skipped.'
    )
})

type UpdateProfileToolInput = z.infer<typeof updateProfileToolInputSchema>

interface UpdateProfileToolOutput {
  content: Array<{ type: 'text'; text: string }>
  error?: string
}

export interface UpdateProfileDeps {
  /** Absolute path to the workspace USER.md. */
  userDocumentPath: string
  /** Template mode — determines valid sections and column schemas. */
  userDocumentMode?: UserDocumentMode
}

function buildDescription(mode?: UserDocumentMode): string {
  const sectionBlock = buildSectionDescriptionBlock(mode)
  return [
    'Update the user profile document (USER.md). Each section is a structured table.',
    '',
    'Sections and columns:',
    sectionBlock,
    '',
    'A "Since" timestamp column is managed automatically — do not include it in entries.',
    '',
    'operation "upsert": Add or update rows. Matches existing rows by the key column (case-insensitive). Provide entries as objects with column names as keys.',
    'operation "remove": Delete rows by key column value. Provide keys array.',
    '',
    'Index-based targeting: provide "indices" (0-based row positions) to target specific rows instead of matching by key.',
    'For "upsert" with indices: entries[i] merges into row at indices[i]; key column is optional.',
    'For "remove" with indices: removes rows at those positions; "keys" is not required.'
  ].join('\n')
}

export function createTool(
  deps: UpdateProfileDeps
): Tool<UpdateProfileToolInput, UpdateProfileToolOutput> {
  const mode = deps.userDocumentMode

  return tool({
    description: buildDescription(mode),
    inputSchema: updateProfileToolInputSchema,
    toModelOutput: ({ output }) =>
      output.error
        ? { type: 'error-text', value: output.error }
        : { type: 'content', value: output.content },
    execute: async (input) => {
      try {
        // Resolve canonical section name
        const canonicalName = getCanonicalSectionName(input.section, mode)
        if (!canonicalName) {
          const sections = buildSectionDescriptionBlock(mode)
          return {
            content: [
              {
                type: 'text',
                text: `Unknown section "${input.section}". Valid sections:\n${sections}`
              }
            ],
            error: `Unknown section "${input.section}".`
          }
        }

        const schema = getSectionSchema(canonicalName, mode)!
        const timestamp = formatTimestamp()

        // Validate operation inputs
        const useIndices = input.indices && input.indices.length > 0

        if (input.operation === 'upsert') {
          if (!input.entries || input.entries.length === 0) {
            return {
              content: [{ type: 'text', text: 'No entries provided for upsert.' }],
              error: 'No entries provided.'
            }
          }

          if (useIndices) {
            // Index mode: entries and indices must have the same length
            if (input.indices!.length !== input.entries.length) {
              return {
                content: [
                  {
                    type: 'text',
                    text: 'When using indices, entries and indices arrays must have the same length.'
                  }
                ],
                error: 'entries/indices length mismatch.'
              }
            }
          } else {
            // Key mode: validate that key column is present in every entry
            for (const entry of input.entries) {
              const keyValue = entry[schema.keyColumn]
              if (!keyValue || keyValue.trim().length === 0) {
                return {
                  content: [
                    {
                      type: 'text',
                      text: `Every entry must include a non-empty "${schema.keyColumn}" column.`
                    }
                  ],
                  error: `Missing key column "${schema.keyColumn}".`
                }
              }
            }
          }
        }

        if (input.operation === 'remove') {
          if (!useIndices && (!input.keys || input.keys.length === 0)) {
            return {
              content: [{ type: 'text', text: 'No keys or indices provided for remove.' }],
              error: 'No keys or indices provided.'
            }
          }
        }

        // Read current document and extract section body
        const doc = await readUserDocument({
          filePath: deps.userDocumentPath,
          mode
        })
        if (!doc) {
          return {
            content: [{ type: 'text', text: 'Could not read USER.md.' }],
            error: 'Could not read USER.md.'
          }
        }

        const lines = doc.content.split('\n')
        const headingRe = new RegExp(
          `^##\\s+${canonicalName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`,
          'i'
        )
        const headingIdx = lines.findIndex((line) => headingRe.test(line))

        // Find section body boundaries
        let bodyStart: number
        let bodyEnd: number

        if (headingIdx === -1) {
          // Section doesn't exist yet — will be appended
          bodyStart = -1
          bodyEnd = -1
        } else {
          bodyStart = headingIdx + 1
          bodyEnd = lines.length
          for (let i = bodyStart; i < lines.length; i++) {
            if (/^##\s/.test(lines[i])) {
              bodyEnd = i
              break
            }
          }
        }

        const bodyLines = bodyStart >= 0 ? lines.slice(bodyStart, bodyEnd) : []

        // Parse existing table + legacy content
        const { rows: existingRows, legacyLines } = parseTable(bodyLines, schema)

        // Migrate legacy freeform lines into table rows
        const migratedRows = [
          ...existingRows,
          ...migrateLegacyLines(legacyLines, schema, timestamp)
        ]

        // Apply operation
        let resultRows: typeof migratedRows
        let summary: string

        if (input.operation === 'upsert') {
          if (useIndices) {
            const res = upsertRowsByIndex(
              migratedRows,
              input.entries!,
              input.indices!,
              schema,
              timestamp
            )
            if (res.error) {
              return {
                content: [{ type: 'text', text: res.error }],
                error: res.error
              }
            }
            resultRows = res.rows
          } else {
            resultRows = upsertRows(migratedRows, input.entries!, schema, timestamp)
          }
          const count = input.entries!.length
          summary = `Upserted ${count} row${count === 1 ? '' : 's'} in "${canonicalName}".`
        } else {
          if (useIndices) {
            const res = removeRowsByIndex(migratedRows, input.indices!)
            if (res.error) {
              return {
                content: [{ type: 'text', text: res.error }],
                error: res.error
              }
            }
            resultRows = res.rows
            summary = `Removed ${res.removed} row${res.removed === 1 ? '' : 's'} from "${canonicalName}".`
          } else {
            resultRows = removeRows(migratedRows, input.keys!, schema)
            const removed = migratedRows.length - resultRows.length
            summary = `Removed ${removed} row${removed === 1 ? '' : 's'} from "${canonicalName}".`
          }
        }

        // Render table and write back
        const tableContent = renderTable(resultRows, schema)
        await patchUserDocumentSection({
          filePath: deps.userDocumentPath,
          section: canonicalName,
          content: tableContent,
          mode
        })

        return {
          content: [{ type: 'text', text: summary }]
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'update_profile failed.'
        return {
          content: [{ type: 'text', text: message }],
          error: message
        }
      }
    }
  })
}
