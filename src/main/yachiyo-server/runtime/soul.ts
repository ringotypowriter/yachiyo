import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { resolveYachiyoSoulPath } from '../config/paths.ts'

const EVOLVED_TRAITS_HEADING = '## Evolved Traits'
const DEFAULT_SOUL_TITLE = '# SOUL'

interface SoulFrontmatter {
  keys: string[]
  values: Map<string, string>
}

interface SoulTraitEntry {
  date: string
  traits: string[]
}

interface ParsedSoulBody {
  beforeSection: string
  entries: SoulTraitEntry[]
  afterSection: string
}

export interface SoulDocument {
  filePath: string
  evolvedTraits: string[]
  lastUpdated: string
}

export interface ReadSoulDocumentInput {
  filePath?: string
}

export interface UpsertDailySoulTraitInput {
  filePath?: string
  now?: Date
  trait: string
}

export interface RemoveSoulTraitInput {
  filePath?: string
  index?: number
  trait?: string
}

function resolveSoulPath(filePath?: string): string {
  return filePath ?? resolveYachiyoSoulPath()
}

function buildDefaultSoulTemplate(): string {
  return [DEFAULT_SOUL_TITLE, '', EVOLVED_TRAITS_HEADING, ''].join('\n')
}

function parseFrontmatter(content: string): { frontmatter: SoulFrontmatter; body: string } {
  if (!content.startsWith('---\n')) {
    return {
      frontmatter: {
        keys: [],
        values: new Map<string, string>()
      },
      body: content
    }
  }

  const endIndex = content.indexOf('\n---\n', 4)
  if (endIndex < 0) {
    return {
      frontmatter: {
        keys: [],
        values: new Map<string, string>()
      },
      body: content
    }
  }

  const rawFrontmatter = content.slice(4, endIndex)
  const values = new Map<string, string>()
  const keys: string[] = []

  for (const line of rawFrontmatter.split('\n')) {
    const separatorIndex = line.indexOf(':')
    if (separatorIndex <= 0) {
      continue
    }

    const key = line.slice(0, separatorIndex).trim()
    const value = line.slice(separatorIndex + 1).trim()
    if (!key) {
      continue
    }

    if (!values.has(key)) {
      keys.push(key)
    }
    values.set(key, value)
  }

  return {
    frontmatter: {
      keys,
      values
    },
    body: content.slice(endIndex + '\n---\n'.length)
  }
}

function findEvolvedTraitsSection(body: string): { start: number; end: number } | null {
  const headingMatch = /^## Evolved Traits\s*$/m.exec(body)
  if (!headingMatch || headingMatch.index === undefined) {
    return null
  }

  const sectionStart = headingMatch.index
  const remainingBody = body.slice(sectionStart + headingMatch[0].length)
  const nextHeadingMatch = /\n##\s+/.exec(remainingBody)
  const sectionEnd =
    nextHeadingMatch && nextHeadingMatch.index !== undefined
      ? sectionStart + headingMatch[0].length + nextHeadingMatch.index + 1
      : body.length

  return {
    start: sectionStart,
    end: sectionEnd
  }
}

function parseTraitsSection(section: string): SoulTraitEntry[] {
  const lines = section.split('\n').slice(1)
  const entries: SoulTraitEntry[] = []
  let currentEntry: SoulTraitEntry | null = null

  for (const rawLine of lines) {
    const line = rawLine.trim()

    const dayHeading = /^###\s+(\d{4}-\d{2}-\d{2})$/.exec(line)
    if (dayHeading) {
      currentEntry = {
        date: dayHeading[1],
        traits: []
      }
      entries.push(currentEntry)
      continue
    }

    const traitLine = /^-\s+(.+)$/.exec(line)
    if (!traitLine) {
      continue
    }

    const trait = traitLine[1].trim()
    if (!trait) {
      continue
    }

    if (!currentEntry) {
      currentEntry = {
        date: 'undated',
        traits: []
      }
      entries.push(currentEntry)
    }

    if (!currentEntry.traits.includes(trait)) {
      currentEntry.traits.push(trait)
    }
  }

  return entries.filter((entry) => entry.traits.length > 0)
}

function parseSoulBody(body: string): ParsedSoulBody {
  const section = findEvolvedTraitsSection(body)
  if (!section) {
    return {
      beforeSection: body,
      entries: [],
      afterSection: ''
    }
  }

  return {
    beforeSection: body.slice(0, section.start),
    entries: parseTraitsSection(body.slice(section.start, section.end)),
    afterSection: body.slice(section.end)
  }
}

function flattenTraits(entries: SoulTraitEntry[]): string[] {
  const seen = new Set<string>()
  const traits: string[] = []

  for (const entry of entries) {
    for (const trait of entry.traits) {
      if (seen.has(trait)) {
        continue
      }

      seen.add(trait)
      traits.push(trait)
    }
  }

  return traits
}

function serializeFrontmatter(frontmatter: SoulFrontmatter): string {
  const lines = frontmatter.keys
    .filter((key) => frontmatter.values.has(key))
    .map((key) => `${key}: ${frontmatter.values.get(key) ?? ''}`)

  return lines.length > 0 ? `---\n${lines.join('\n')}\n---\n\n` : ''
}

function serializeTraitsSection(entries: SoulTraitEntry[]): string {
  const lines = [EVOLVED_TRAITS_HEADING]

  for (const entry of entries) {
    if (entry.date !== 'undated') {
      lines.push(`### ${entry.date}`)
    }

    lines.push(...entry.traits.map((trait) => `- ${trait}`))
    lines.push('')
  }

  while (lines.at(-1) === '') {
    lines.pop()
  }

  return lines.join('\n')
}

function ensureSoulPreamble(beforeSection: string): string {
  const trimmed = beforeSection.trimEnd()
  if (trimmed.length > 0) {
    return trimmed
  }

  return `${DEFAULT_SOUL_TITLE}\n`
}

function serializeSoulBody(parsed: ParsedSoulBody): string {
  const parts: string[] = []
  const beforeSection = ensureSoulPreamble(parsed.beforeSection).trimEnd()
  if (beforeSection) {
    parts.push(beforeSection)
  }

  parts.push(serializeTraitsSection(parsed.entries))

  const afterSection = parsed.afterSection.trim()
  if (afterSection) {
    parts.push(afterSection)
  }

  return `${parts.join('\n\n').trim()}\n`
}

export async function readSoulDocument(
  input: ReadSoulDocumentInput = {}
): Promise<SoulDocument | null> {
  const filePath = resolveSoulPath(input.filePath)
  let content: string

  try {
    content = await readFile(filePath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      content = buildDefaultSoulTemplate()
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, content)
    } else {
      throw error
    }
  }

  const { frontmatter, body } = parseFrontmatter(content)
  const parsedBody = parseSoulBody(body)

  return {
    filePath,
    evolvedTraits: flattenTraits(parsedBody.entries),
    lastUpdated: frontmatter.values.get('last_updated') ?? ''
  }
}

export async function removeSoulTrait(input: RemoveSoulTraitInput): Promise<SoulDocument | null> {
  const filePath = resolveSoulPath(input.filePath)

  let content: string
  try {
    content = await readFile(filePath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }
    throw error
  }

  const { frontmatter, body } = parseFrontmatter(content)
  const parsedBody = parseSoulBody(body)
  const flattened = flattenTraits(parsedBody.entries)

  let traitText: string
  if (input.index !== undefined) {
    const found = flattened[input.index]
    if (found === undefined) {
      throw new Error(`Trait index ${input.index} is out of range (${flattened.length} traits).`)
    }
    traitText = found
  } else if (input.trait !== undefined) {
    const normalized = input.trait.trim()
    if (!flattened.includes(normalized)) {
      throw new Error(`Trait not found: "${normalized}"`)
    }
    traitText = normalized
  } else {
    throw new Error('Either index or trait must be provided to removeSoulTrait.')
  }

  const updatedEntries = parsedBody.entries
    .map((entry) => ({ ...entry, traits: entry.traits.filter((t) => t !== traitText) }))
    .filter((entry) => entry.traits.length > 0)

  const timestamp = new Date().toISOString()
  if (!frontmatter.values.has('last_updated')) {
    frontmatter.keys.push('last_updated')
  }
  frontmatter.values.set('last_updated', timestamp)

  const updatedBody: ParsedSoulBody = { ...parsedBody, entries: updatedEntries }
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, `${serializeFrontmatter(frontmatter)}${serializeSoulBody(updatedBody)}`)

  return readSoulDocument({ filePath })
}

export async function upsertDailySoulTrait(
  input: UpsertDailySoulTraitInput
): Promise<SoulDocument | null> {
  const trait = input.trait.trim()
  if (!trait) {
    return readSoulDocument({ filePath: input.filePath })
  }

  const filePath = resolveSoulPath(input.filePath)
  const timestamp = (input.now ?? new Date()).toISOString()
  const day = timestamp.slice(0, 10)

  let content = ''
  try {
    content = await readFile(filePath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
  }

  const { frontmatter, body } = parseFrontmatter(content)
  const parsedBody = parseSoulBody(body)
  const existingEntry = parsedBody.entries.find((entry) => entry.date === day)

  if (existingEntry) {
    if (!existingEntry.traits.includes(trait)) {
      existingEntry.traits.push(trait)
    }
  } else {
    parsedBody.entries.push({
      date: day,
      traits: [trait]
    })
  }

  if (!frontmatter.values.has('last_updated')) {
    frontmatter.keys.push('last_updated')
  }
  frontmatter.values.set('last_updated', timestamp)

  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, `${serializeFrontmatter(frontmatter)}${serializeSoulBody(parsedBody)}`)

  return readSoulDocument({ filePath })
}
