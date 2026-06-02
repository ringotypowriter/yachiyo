import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { QueryReminderSection } from '../../../../runtime/context/queryReminder.ts'
import { getThreadPlanDocumentFilename, PLAN_DOCUMENT_DIR_NAME } from '@yachiyo/shared/planMode'

export async function ensurePlanDocument(input: {
  workspacePath: string
  threadId: string
  goal: string
}): Promise<{
  planRelativePath: string
  planAbsolutePath: string
  fallbackAbsolutePaths: string[]
}> {
  const planDir = join(input.workspacePath, PLAN_DOCUMENT_DIR_NAME)
  await mkdir(planDir, { recursive: true })

  const filename = getThreadPlanDocumentFilename(input.threadId)
  const planAbsolutePath = join(planDir, filename)
  const planRelativePath = `${PLAN_DOCUMENT_DIR_NAME}/${filename}`
  const fallbackAbsolutePaths = [join(homedir(), PLAN_DOCUMENT_DIR_NAME, filename)]
  const existingPlan = await readFile(planAbsolutePath, 'utf8').catch(() => null)

  if (existingPlan === null) {
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

  return { planRelativePath, planAbsolutePath, fallbackAbsolutePaths }
}
export function buildPlanModeReminderSection(input: {
  planRelativePath: string
}): QueryReminderSection {
  return {
    key: 'plan-mode',
    title: 'Plan Mode',
    lines: [
      // Highest priority: the handoff framing defines the entire purpose.
      `This plan is a self-contained handoff for another agent that will execute it in a new thread. Every section must give the executing agent exactly what it needs — no context from this conversation carries over.`,
      `Treat the user's latest request as the goal for this Plan Mode turn; derive the concrete goal from it, then write and update the plan at ${input.planRelativePath} using the write tool (overwrite the full file each time).`,
      // One positive tool-scope line replaces three scattered restriction lines.
      'Tools available for exploration: read, grep, glob, webRead, webSearch, and bash for reading and searching files (no writes, no edits, no running commands). Use write only on the plan file. Do not create, modify, or delete any other file.',
      'Before writing the plan, explore the codebase to verify file paths, existing patterns, test conventions, and related modules. The plan must reflect the actual codebase.',
      'Use five sections: # Execution Plan, then ## Goal (one sentence — the concrete outcome), ## Context (relevant files, existing patterns, key types, constraints — not project background), ## Steps (ordered executable actions), and ## Validation (specific test files, typecheck commands, or manual checks).',
      "Write the plan in the same language as the user's messages.",
      'Prefer bullets. Use fenced code blocks only for exact file paths, type signatures, shell commands, or diffs. Each bullet names one concrete action.',
      'Write steps in dependency order. Each step names one concrete outcome and the primary file or module — an action an agent can complete without further decomposition.',
      'Make decisions and state them. Include brief rationale when the choice is not obvious from existing code patterns. Do not leave decisions open — use askUser if a decision is truly blocking.',
      'Include project file paths and reusable symbols inline when they matter. Do not mention the plan file path, Plan Mode mechanics, or exitPlanMode inside the plan document.',
      'Update the plan progressively as you learn; replace vague bullets with concrete execution bullets.',
      'Keep your assistant message minimal. The plan document is the output. When the plan is executable, call exitPlanMode.'
    ]
  }
}
