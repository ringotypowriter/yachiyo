export interface AskUserBranchDraft {
  text: string
  initialCursorOffset: number
}

/**
 * The truncated askUser question is gone from the branch's model history, so the
 * user's reply must carry it: quote the question and leave the cursor below it.
 */
export function buildAskUserBranchDraft(question: string): AskUserBranchDraft {
  const text =
    question
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n') + '\n\n'
  return { text, initialCursorOffset: text.length }
}
