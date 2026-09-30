import type { MessageRecord, ToolCallRecord } from '@yachiyo/shared/protocol'

/** UI-only best-effort summary; no raw tool input/output or answer text goes to the tool model. */
export const DECK_SUMMARY_INSTRUCTION =
  'Describe what the assistant is doing or found from this tool activity in one short, concrete status line. Write in the supplied conversation language, not the language of tool names, commands, paths, or results. Ground completed outcomes in the tool results and describe unfinished work as ongoing. Return only the status line, without a label or formatting.'

type LanguageCueMessage = Pick<MessageRecord, 'role' | 'content' | 'hidden' | 'parentMessageId'>

function languageOf(text: string): string {
  const prose = text.replace(/```[\s\S]*?```|`[^`]*`/g, ' ')
  const lines = prose
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  for (const line of [lines.at(-1), lines[0]]) {
    if (!line) continue
    const requestedLanguage = line.match(
      /\b(?:in|into|to)\s+(English|Chinese|Japanese|Korean)\b/i
    )?.[1]
    if (requestedLanguage) {
      return requestedLanguage[0]!.toUpperCase() + requestedLanguage.slice(1).toLowerCase()
    }
    const chineseLanguageName = line.match(/(?:用|以)(中文|英文|日文|韩文)/)?.[1]
    if (chineseLanguageName) {
      return { 中文: 'Chinese', 英文: 'English', 日文: 'Japanese', 韩文: 'Korean' }[
        chineseLanguageName as '中文' | '英文' | '日文' | '韩文'
      ]
    }
  }
  const languageOfLine = (line: string): string | undefined => {
    // A path or command is a token, not dozens of votes for English.
    const latinTokens = line.match(/[A-Za-z][A-Za-z0-9_./\\-]*/g)?.length ?? 0
    const kana = line.match(/[\p{Script=Hiragana}\p{Script=Katakana}]/gu)?.length ?? 0
    const hangul = line.match(/\p{Script=Hangul}/gu)?.length ?? 0
    const han = line.match(/\p{Script=Han}/gu)?.length ?? 0
    if (kana > 0 && kana * 2 >= latinTokens * 3) return 'Japanese'
    if (hangul > 0 && hangul * 2 >= latinTokens * 3) return 'Korean'
    if (han > 0 && han * 2 >= latinTokens * 3) return 'Chinese'
    return latinTokens > 0 ? 'English' : undefined
  }
  const languages = [lines.at(-1), lines[0]].map((line) => line && languageOfLine(line))
  return (
    languages.find((language) => language && language !== 'English') ?? languages[0] ?? 'English'
  )
}

export function findDeckSummaryLanguageCue(
  getMessage: (messageId: string) => LanguageCueMessage | undefined,
  requestMessageId: string
): string {
  let messageId: string | undefined = requestMessageId
  while (messageId) {
    const message = getMessage(messageId)
    if (!message) break
    if (message.role === 'user' && !message.hidden && message.content.trim()) {
      return languageOf(message.content)
    }
    messageId = message.parentMessageId
  }
  return ''
}

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
