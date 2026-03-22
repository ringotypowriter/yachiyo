export type ConversationGroupSectionKind =
  | 'reply-nav'
  | 'tool-calls'
  | 'assistant-bubble'
  | 'preparing'

export function buildConversationGroupSectionKinds(input: {
  hasActiveBranch: boolean
  hideActiveBranchWhilePreparing: boolean
  replyCount: number
  showPreparing: boolean
  visibleToolCallCount: number
}): ConversationGroupSectionKind[] {
  const sections: ConversationGroupSectionKind[] = []

  if (input.replyCount > 1) {
    sections.push('reply-nav')
  }

  if (input.visibleToolCallCount > 0) {
    sections.push('tool-calls')
  }

  if (input.hasActiveBranch && !input.hideActiveBranchWhilePreparing) {
    sections.push('assistant-bubble')
  }

  if (input.showPreparing) {
    sections.push('preparing')
  }

  return sections
}
