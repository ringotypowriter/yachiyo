import type { MessageSearchHit, ThreadDump, ThreadSummary } from '../services/threadSearch.ts'

export function formatSearchResultsText(hits: MessageSearchHit[]): string {
  if (hits.length === 0) return '(no results)'
  return hits
    .map((h) => {
      const role = h.role === 'assistant' ? 'model' : 'user'
      return `[ThreadID: ${h.threadId}] ${h.date} Role: ${role} Content: ${h.snippet}`
    })
    .join('\n')
}

export function formatThreadListText(threads: ThreadSummary[]): string {
  if (threads.length === 0) return '(no threads)'
  return threads
    .map((t) => {
      const firstQ = t.firstUserQuery ?? '(no user message)'
      const updated = t.updatedAt.slice(0, 19).replace('T', ' ')
      const reviewed = t.selfReviewedAt ? ' [reviewed]' : ''
      return `[${t.threadId}] ${updated} (${t.messageCount} msgs)${reviewed} ${t.title}\n  q: ${firstQ}`
    })
    .join('\n')
}

export function formatThreadDumpText(dump: ThreadDump): string {
  const header = `Thread ${dump.threadId}: ${dump.title}\nUpdated: ${dump.updatedAt}  Messages: ${dump.messages.length}  Tool calls: ${dump.toolCalls.length}`
  if (dump.messages.length === 0 && dump.toolCalls.length === 0) {
    return `${header}\n(no messages)`
  }
  const messageBody =
    dump.messages.length === 0
      ? ''
      : dump.messages
          .map((m) => {
            const role = m.role === 'assistant' ? 'model' : m.role
            const ts = m.createdAt.slice(0, 19).replace('T', ' ')
            return `── ${role} @ ${ts} [${m.messageId}] ──\n${m.content}`
          })
          .join('\n\n')

  const toolBody =
    dump.toolCalls.length === 0
      ? ''
      : `── tool calls ──\n${dump.toolCalls
          .map((c) => {
            const ts = c.startedAt.slice(0, 19).replace('T', ' ')
            const step = c.stepIndex != null ? ` #${c.stepIndex}` : ''
            const tail = c.error ? `  ERROR: ${c.error}` : ''
            return `- ${ts}${step} ${c.toolName} [${c.status}] ${c.inputSummary}${tail}`
          })
          .join('\n')}`

  const sections = [header, messageBody, toolBody].filter((s) => s.length > 0)
  return sections.join('\n\n')
}
