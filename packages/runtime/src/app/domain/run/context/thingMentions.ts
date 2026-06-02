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
    resolutions.push(await input.thingDomain.resolveThingMention(name))
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
    'A Thing summary describes the stable topic/project/decision/context. Sources are conversation previews with references, not exact evidence quotes.',
    'If the answer needs detail that is not present in the source previews below, use querySource to open the listed sourceRowId before making factual claims.',
    ''
  ]

  for (const resolution of resolvedThings) {
    const thing = resolution.thing
    lines.push(`#${thing.name}`)
    lines.push(`Summary: ${thing.summary}`)
    if (thing.sources.length > 0) {
      lines.push('Sources:')
      for (const source of thing.sources) {
        const refs = [
          `sourceRowId: ${source.sourceRowId}`,
          `threadId: ${source.threadId}`,
          source.messageId ? `messageId: ${source.messageId}` : '',
          source.spanRowId ? `spanRowId: ${source.spanRowId}` : ''
        ].filter(Boolean)
        lines.push(`- ${source.preview} (${refs.join(', ')})`)
      }
    }
    lines.push('')
  }

  lines.push('</thing-context>')
  return lines.join('\n')
}
