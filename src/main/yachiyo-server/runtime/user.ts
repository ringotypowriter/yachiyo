import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { resolveYachiyoUserPath } from '../config/paths.ts'

const DEFAULT_USER_TEMPLATE = [
  '# USER',
  '',
  "This file is for Yachiyo's durable understanding of the user.",
  '',
  '- Keep stable background, preferences, communication style, and work style here.',
  '- Do not use this file for temporary task state, recalled memory dumps, or chat transcripts.',
  '',
  '## Profile',
  '',
  '## Preferences',
  '',
  '## Collaboration Notes',
  ''
].join('\n')

const DEFAULT_GUEST_USER_TEMPLATE = [
  '# USER',
  '',
  'This is a guest user invited by the owner.',
  '',
  '## Profile',
  '',
  '## Preferences',
  '',
  '## Notes',
  ''
].join('\n')

const DEFAULT_GROUP_USER_TEMPLATE = [
  '# Group',
  '',
  'Context notes for this group chat. Yachiyo reads this before every probe.',
  '',
  '## People',
  '',
  '<!-- Map nicknames to real identities so the model knows who is who. -->',
  '<!-- Rows with empty notes are fine — just the mapping helps. -->',
  '',
  '| Nickname | Identity / Real Name | Notes |',
  '|----------|----------------------|-------|',
  '| ExampleUser | Alice | owner, close friend |',
  '',
  '## Group Vibe',
  '',
  '<!-- Describe the general tone, topics, and dynamics of this group. -->',
  '',
  '## Topic Hints',
  '',
  '<!-- Anything Yachiyo should know or care about in this group. -->',
  ''
].join('\n')

export interface UserDocument {
  filePath: string
  content: string
}

export type UserDocumentMode = 'owner' | 'guest' | 'group'

export interface ReadUserDocumentInput {
  filePath?: string
  /** When true, use the guest template for new USER.md files. */
  guest?: boolean
  /** Template mode for auto-created files. Overrides `guest` when set. */
  mode?: UserDocumentMode
}

export interface WriteUserDocumentInput {
  filePath?: string
  content: string
}

function buildDefaultUserTemplateForMode(mode: UserDocumentMode): string {
  return mode === 'group'
    ? DEFAULT_GROUP_USER_TEMPLATE
    : mode === 'guest'
      ? DEFAULT_GUEST_USER_TEMPLATE
      : buildDefaultUserTemplate()
}

function resolveUserPath(filePath?: string): string {
  return filePath ?? resolveYachiyoUserPath()
}

function normalizeUserDocumentContent(content: string): string {
  const normalized = content.replace(/\r\n/g, '\n')
  return normalized.endsWith('\n') ? normalized : `${normalized}\n`
}

export function buildDefaultUserTemplate(): string {
  return DEFAULT_USER_TEMPLATE
}

export async function readUserDocument(
  input: ReadUserDocumentInput = {}
): Promise<UserDocument | null> {
  const filePath = resolveUserPath(input.filePath)
  let content: string

  try {
    content = await readFile(filePath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }

    const mode = input.mode ?? (input.guest ? 'guest' : 'owner')
    content = buildDefaultUserTemplateForMode(mode)
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, content, 'utf8')
  }

  return {
    filePath,
    content: normalizeUserDocumentContent(content)
  }
}

export async function writeUserDocument(
  input: WriteUserDocumentInput
): Promise<UserDocument | null> {
  const filePath = resolveUserPath(input.filePath)
  const content = normalizeUserDocumentContent(input.content)

  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, content, 'utf8')

  return {
    filePath,
    content
  }
}

export interface PatchUserDocumentSectionInput {
  filePath?: string
  /** The `## Heading` name to patch (case-insensitive). Created at end of file if absent. */
  section: string
  content: string
  /** Template mode used only when the file does not exist yet. */
  mode?: UserDocumentMode
}

function escapeRegexChars(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function findSectionHeadingIndex(lines: string[], sectionName: string): number {
  const headingRe = new RegExp(`^##\\s+${escapeRegexChars(sectionName)}\\s*$`, 'i')
  return lines.findIndex((line) => headingRe.test(line))
}

/**
 * Surgically replace the body of a single `## Section` in USER.md without
 * touching any other section. If the heading does not exist it is appended.
 */
export async function patchUserDocumentSection(
  input: PatchUserDocumentSectionInput
): Promise<UserDocument | null> {
  const current = await readUserDocument({ filePath: input.filePath, mode: input.mode })
  if (!current) return null

  // Canonicalize: strip surrounding whitespace and any leading "## " prefix so
  // callers passing "## People" or "People " all resolve to the same heading.
  const sectionName = input.section.trim().replace(/^#+\s*/, '')

  let baseContent = current.content
  let lines = baseContent.split('\n')
  let headingIdx = findSectionHeadingIndex(lines, sectionName)

  // If an earlier full rewrite destroyed the heading structure entirely, rebuild
  // from the canonical template for the known mode before patching the section.
  if (headingIdx === -1 && input.mode === 'group' && !lines.some((line) => /^##\s+/.test(line))) {
    baseContent = normalizeUserDocumentContent(buildDefaultUserTemplateForMode(input.mode))
    lines = baseContent.split('\n')
    headingIdx = findSectionHeadingIndex(lines, sectionName)
  }

  if (headingIdx === -1) {
    const appended = baseContent.trimEnd() + `\n\n## ${sectionName}\n\n${input.content.trim()}\n`
    return writeUserDocument({ filePath: input.filePath, content: appended })
  }

  // Find where this section ends: next ## heading or EOF
  let endIdx = lines.length
  for (let i = headingIdx + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) {
      endIdx = i
      break
    }
  }

  const before = lines.slice(0, headingIdx + 1)
  const after = lines.slice(endIdx)
  const body = ['', ...input.content.trim().split('\n'), '']

  return writeUserDocument({
    filePath: input.filePath,
    content: [...before, ...body, ...after].join('\n')
  })
}
