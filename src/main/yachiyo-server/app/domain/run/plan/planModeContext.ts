import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

import type { QueryReminderSection } from '../../../../runtime/context/queryReminder.ts'
import {
  normalizePlanDocumentFilename,
  PLAN_CURRENT_FILENAME,
  PLAN_DOCUMENT_DIR_NAME
} from '../../../../../../shared/yachiyo/planMode.ts'

function randomLetters(length: number): string {
  const bytes = randomBytes(length)
  const aCode = 'a'.charCodeAt(0)
  const letters: string[] = []
  for (let i = 0; i < length; i += 1) {
    letters.push(String.fromCharCode(aCode + (bytes[i]! % 26)))
  }
  return letters.join('')
}

export async function ensurePlanDocument(input: {
  workspacePath: string
  goal: string
}): Promise<{ planRelativePath: string; planAbsolutePath: string }> {
  const planDir = join(input.workspacePath, PLAN_DOCUMENT_DIR_NAME)
  await mkdir(planDir, { recursive: true })

  const currentPath = join(planDir, PLAN_CURRENT_FILENAME)
  const existingCurrent = await readFile(currentPath, 'utf8').catch(() => null)
  const existingFilename = existingCurrent ? normalizePlanDocumentFilename(existingCurrent) : null

  const filename = existingFilename ?? `plan-${randomLetters(6)}.md`
  const planAbsolutePath = join(planDir, filename)
  const planRelativePath = `${PLAN_DOCUMENT_DIR_NAME}/${filename}`

  if (!existingFilename) {
    await writeFile(currentPath, `${filename}\n`, 'utf8')
    await writeFile(
      planAbsolutePath,
      [
        '# Execution Plan',
        '',
        '## Goal',
        input.goal.trim() || '(empty)',
        '',
        '## Context',
        '',
        '## Steps',
        '',
        '## Validation',
        ''
      ].join('\n'),
      'utf8'
    )
  }

  return { planRelativePath, planAbsolutePath }
}
export function buildPlanModeReminderSection(input: {
  planRelativePath: string
}): QueryReminderSection {
  return {
    key: 'plan-mode',
    title: 'Plan Mode',
    lines: [
      `Treat the user's latest request as the goal for this Plan Mode turn; derive the concrete goal from it, then write and update the plan at ${input.planRelativePath} using the write tool (overwrite the full file each time).`,
      'Only write to that plan file. Do not write or edit any other files, and do not run execution commands.',
      'The bash tool is available for read-only operations (searching and reading files), but not for writing, editing, or running commands.',
      'This plan is a self-contained handoff for another agent that will execute it in a new thread.',
      'Use this exact document shape: # Execution Plan, ## Goal, ## Context, ## Steps, ## Validation.',
      "Write the plan in the same language as the user's messages. Do not switch languages.",
      'Keep the plan under 40 lines. Use bullets only. Do not use code blocks or long prose.',
      'Write executable steps in order. Each step must name the concrete action and the relevant file, module, command, or UI surface when known.',
      'Eliminate downstream decisions: do not write alternatives, recommendations, options, risks, assumptions, or open questions in the plan.',
      'If a blocking decision remains, use askUser before finalizing instead of recording the uncertainty in the plan.',
      'Include project file paths and reusable symbols inline when they matter, but do not mention the plan file path, Plan Mode mechanics, or exitPlanMode inside the plan document.',
      'Update the plan progressively as you learn; keep replacing vague bullets with concrete execution bullets.',
      'Do not describe the plan in the assistant message. When the plan is executable, call exitPlanMode; do not end Plan Mode by writing text.'
    ]
  }
}
