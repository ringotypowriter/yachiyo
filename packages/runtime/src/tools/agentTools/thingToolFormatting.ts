import type { ThingRecord, ThingSourceRecord } from '@yachiyo/shared/protocol'

export function formatThingListText(things: ThingRecord[]): string {
  const header = `Found ${things.length} thing${things.length === 1 ? '' : 's'}.`
  if (things.length === 0) return header
  return [header, ...things.map(formatThingListItem)].join('\n')
}

export function formatThingDetailText(thing: ThingRecord): string {
  const lines = [
    `#${thing.name}`,
    `Status: ${thing.isInactive ? 'inactive' : 'active'}`,
    `Summary: ${thing.summary || 'No summary.'}`,
    `Sources: ${thing.sources.length}`
  ]

  if (thing.sources.length === 0) {
    lines.push('- No source previews saved.')
  } else {
    lines.push(...thing.sources.map(formatThingSourceLine))
  }

  return lines.join('\n')
}

function formatThingListItem(thing: ThingRecord): string {
  const status = thing.isInactive ? 'inactive' : 'active'
  const sourceCount = `${thing.sources.length} source${thing.sources.length === 1 ? '' : 's'}`
  return `- #${thing.name} — ${thing.summary || 'No summary.'} (${status}, ${sourceCount})`
}

function formatThingSourceLine(source: ThingSourceRecord): string {
  return `- ${source.preview} (${formatSourceRefs(source)})`
}

function formatSourceRefs(source: ThingSourceRecord): string {
  const refs = [
    `sourceRowId: ${source.sourceRowId}`,
    `threadId: ${source.threadId}`,
    source.messageId ? `messageId: ${source.messageId}` : '',
    source.spanRowId ? `spanRowId: ${source.spanRowId}` : ''
  ].filter(Boolean)
  return refs.join(', ')
}
