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

export interface UserDocument {
  filePath: string
  content: string
}

export interface ReadUserDocumentInput {
  filePath?: string
  /** When true, use the guest template for new USER.md files. */
  guest?: boolean
}

export interface WriteUserDocumentInput {
  filePath?: string
  content: string
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

    content = input.guest ? DEFAULT_GUEST_USER_TEMPLATE : buildDefaultUserTemplate()
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
