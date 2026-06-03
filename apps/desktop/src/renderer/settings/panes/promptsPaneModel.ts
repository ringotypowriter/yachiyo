import type { UserPrompt } from '@yachiyo/shared/protocol'

export interface PromptDraftRow {
  keycode: string
  text: string
}

export function promptRowsFromStoredPrompts(prompts: UserPrompt[] | undefined): PromptDraftRow[] {
  return [...(prompts ?? [])]
    .reverse()
    .map((prompt) => ({ keycode: prompt.keycode, text: prompt.text }))
}

export function promptRowsToStoredOrder(rows: PromptDraftRow[]): PromptDraftRow[] {
  return [...rows].reverse()
}

export function prependPromptDraftRow(rows: PromptDraftRow[]): PromptDraftRow[] {
  return [{ keycode: '', text: '' }, ...rows]
}

export function shiftPromptKeycodeErrorsForPrependedRow(
  errors: Record<number, string>
): Record<number, string> {
  const next: Record<number, string> = {}
  for (const [key, value] of Object.entries(errors)) {
    next[Number(key) + 1] = value
  }
  return next
}
