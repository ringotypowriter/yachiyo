import type { ThingRecord } from '@renderer/app/types'

export interface ThingMentionCommand {
  id: string
  label: string
  description: string
  insertText: string
}

export function buildThingMentionCompletionCommands(input: {
  things: ThingRecord[]
  query: string
  limit?: number
}): ThingMentionCommand[] {
  const query = input.query.toLowerCase().replace(/^#/, '')
  const limit = input.limit ?? 8
  return input.things
    .filter((thing) => !thing.isInactive)
    .filter((thing) => !query || thing.name.includes(query))
    .slice(0, limit)
    .map((thing) => ({
      id: thing.id,
      label: `#${thing.name}`,
      description: thing.summary,
      insertText: `#${thing.name}`
    }))
}

export function getThingMentionQuery(value: string, cursor: number): string | null {
  const beforeCursor = value.slice(0, cursor)
  const match = /(?:^|\s)#([A-Za-z0-9_-]*)$/.exec(beforeCursor)
  return match ? match[1] : null
}
