import type { ToolCallRecord } from '@yachiyo/shared/protocol'

/** UI-only best-effort summary; no raw tool input/output or answer text goes to the tool model. */
export const DECK_SUMMARY_INSTRUCTION =
  'Write one concise English present-tense UI heading (at most 10 words) describing the work these tools are doing. Use only tool names, statuses, short input/output summaries and paths below. Do not mention the user, invent results, or give instructions. Return only the heading.'

export interface DeckSummaryScheduler {
  start(call: ToolCallRecord, replacedPreparingId?: string): void
  complete(call: ToolCallRecord): void
  textBoundary(): void
  finish(): void
  close(): void
}

interface Deck {
  calls: ToolCallRecord[]
  revision: number
  summarizedRevision: number
  lastStartedAt: number
  sealed: boolean
  timer?: ReturnType<typeof setTimeout>
}

export function createDeckSummaryScheduler(input: {
  generate: (calls: ToolCallRecord[]) => Promise<string | undefined>
  update: (first: ToolCallRecord) => void
  throttleMs?: number
}): DeckSummaryScheduler {
  const throttleMs = input.throttleMs ?? 8000
  const newDeck = (): Deck => ({
    calls: [],
    revision: 0,
    summarizedRevision: -1,
    lastStartedAt: 0,
    sealed: false
  })
  const decks: Deck[] = []
  let current = newDeck()
  let inFlight = false
  let stopped = false
  let final = false

  function schedule(): void {
    if (stopped || inFlight) return
    for (const deck of decks) {
      if (
        !deck.calls.some((call) => call.status !== 'preparing') ||
        deck.revision === deck.summarizedRevision
      )
        continue
      const delay =
        deck.sealed || final || !deck.lastStartedAt
          ? 0
          : Math.max(0, throttleMs - (Date.now() - deck.lastStartedAt))
      if (delay) {
        if (!deck.timer)
          deck.timer = setTimeout(() => {
            deck.timer = undefined
            schedule()
          }, delay)
      } else {
        void run(deck)
        return
      }
    }
  }

  async function run(deck: Deck): Promise<void> {
    if (stopped || inFlight) return
    if (deck.timer) clearTimeout(deck.timer)
    deck.timer = undefined
    inFlight = true
    deck.lastStartedAt = Date.now()
    // Preparing records have no input yet; the first running call can be summarized immediately.
    const snapshot = deck.calls.filter((call) => call.status !== 'preparing')
    const revision = deck.revision
    try {
      const summary = (await input.generate(snapshot))?.trim()
      if (!stopped && summary && deck.calls[0]) {
        // The snapshot is still valid after newer calls arrive. Use the current head so
        // a provisional preparing ID remapped during generation is never published.
        input.update({ ...deck.calls[0], deckSummary: summary })
      }
    } catch {
      // Optional UI metadata must not interrupt tool execution or the main answer.
    } finally {
      inFlight = false
      if (revision === deck.revision) deck.summarizedRevision = revision
      schedule()
    }
  }

  function record(call: ToolCallRecord, replacedPreparingId?: string): void {
    if (stopped || final || call.toolName === 'askUser') return
    const deck =
      decks.find((candidate) =>
        candidate.calls.some(
          (previous) => previous.id === call.id || previous.id === replacedPreparingId
        )
      ) ?? current
    if (!decks.includes(deck)) decks.push(deck)
    const index = deck.calls.findIndex(
      (previous) => previous.id === call.id || previous.id === replacedPreparingId
    )
    if (index < 0) deck.calls.push(call)
    else deck.calls[index] = call
    deck.revision++
    schedule()
  }

  return {
    start: record,
    complete: record,
    textBoundary() {
      if (!current.calls.length) return
      current.sealed = true
      if (current.timer) clearTimeout(current.timer)
      current.timer = undefined
      current = newDeck()
      schedule()
    },
    finish() {
      final = true
      current.sealed = true
      for (const deck of decks) {
        if (deck.timer) clearTimeout(deck.timer)
        deck.timer = undefined
        deck.sealed = true
      }
      schedule()
    },
    close() {
      stopped = true
      for (const deck of decks) if (deck.timer) clearTimeout(deck.timer)
    }
  }
}
