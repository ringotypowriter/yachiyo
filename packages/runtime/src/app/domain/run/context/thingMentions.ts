import type { ThingMentionResolution, ThingRecord } from '@yachiyo/shared/protocol'
import type { ThingDomain } from '../../things/thingDomain.ts'

const THING_MENTION_RE = /(^|[^\w#])#([A-Za-z][A-Za-z0-9_-]*)/g

export function extractThingMentionNames(content: string): string[] {
  const names: string[] = []
  const seen = new Set<string>()
  const lines = content.split('\n')

  for (const line of lines) {
    const isHeading = /^\s{0,3}#{1,6}\s/.test(line)
    if (isHeading) {
      continue
    }

    THING_MENTION_RE.lastIndex = 0
    for (const match of line.matchAll(THING_MENTION_RE)) {
      const raw = match[2]
      if (/^[0-9a-f]{3,8}$/i.test(raw)) continue
      const key = raw.toLowerCase().replace(/_+/g, '-')
      if (!seen.has(key)) {
        seen.add(key)
        names.push(raw)
      }
    }
  }

  return names
}

export async function resolveThingMentionsForUserQuery(input: {
  content: string
  thingDomain?: ThingDomain
  threadId?: string
}): Promise<ThingMentionResolution[]> {
  if (!input.thingDomain) return []
  const names = extractThingMentionNames(input.content)
  const resolutions: ThingMentionResolution[] = []
  for (const name of names) {
    const resolution = await input.thingDomain.resolveThingMention(name)
    if (resolution.resolved && resolution.thing && input.threadId) {
      await input.thingDomain.linkThread({ name: resolution.thing.name, threadId: input.threadId })
    }
    resolutions.push(resolution)
  }
  return resolutions
}

export function buildThingContextBlock(resolutions: ThingMentionResolution[]): string | undefined {
  const resolvedThings = resolutions.filter(
    (resolution): resolution is ThingMentionResolution & { thing: ThingRecord } =>
      Boolean(resolution.resolved && resolution.thing)
  )

  if (resolvedThings.length === 0) return undefined

  const lines = [
    '<thing-context>',
    'The user mentioned these non-stale Things. Use them as hidden context indexes for this turn.',
    'Source quotes and references are the factual record. Summaries only help identify the Thing; do not cite or rely on summaries as evidence.',
    'If the answer needs detail that is not present in the quotes below, use querySource to open the listed references before making factual claims.',
    'If you write user-visible Thing summary/description text this turn, use the main language of the included chats/source quotes. There is no stored language field.',
    ''
  ]

  for (const resolution of resolvedThings) {
    const thing = resolution.thing
    lines.push(`#${thing.name}`)
    lines.push(`Summary: ${thing.summary}`)
    if (thing.includedChats.length > 0) {
      lines.push('Included chats:')
      for (const chat of thing.includedChats) {
        lines.push(`- ${chat.threadTitle ?? chat.threadId} (threadId: ${chat.threadId})`)
      }
    }
    if (thing.sourceQuotes.length > 0) {
      lines.push('Source quotes:')
      for (const quote of thing.sourceQuotes) {
        const refs = [
          `sourceRowId: ${quote.sourceRowId}`,
          `threadId: ${quote.threadId}`,
          quote.messageId ? `messageId: ${quote.messageId}` : '',
          quote.spanRowId ? `spanRowId: ${quote.spanRowId}` : ''
        ].filter(Boolean)
        lines.push(`- "${quote.quote}" (${refs.join(', ')})`)
      }
    }
    lines.push('')
  }

  lines.push('</thing-context>')
  return lines.join('\n')
}
