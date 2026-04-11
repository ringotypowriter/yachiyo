import { mkdir, writeFile, access } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'

import type { MessageRecord, ThreadRecord } from '../../../../shared/yachiyo/protocol.ts'
import { resolveYachiyoDataDir } from '../../config/paths.ts'
import type { YachiyoStorage } from '../../storage/storage.ts'

/**
 * Download a remote image referenced by an assistant message's markdown
 * content, persist it to disk, and rewrite the stored message so future
 * renders point at the local copy.
 *
 * Returns the absolute path of the saved file, or throws if the URL
 * cannot be found in the message, the response is not an image, or the
 * write fails.
 */

const CONTENT_TYPE_TO_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'image/bmp': '.bmp',
  'image/avif': '.avif'
}

const WORKSPACE_ATTACHMENT_SUBDIR = '.yachiyo'
const DATADIR_ATTACHMENT_SUBDIR = 'attachments'

export interface DownloadRemoteImageInput {
  threadId: string
  messageId: string
  url: string
}

export interface DownloadRemoteImageResult {
  /** Absolute path on disk where the image was written. */
  absPath: string
  /** The new message content with `url` replaced by `absPath`. */
  updatedContent: string
}

export interface RemoteImageFetchResponse {
  contentType: string
  bytes: Uint8Array
}

export type RemoteImageFetcher = (url: string) => Promise<RemoteImageFetchResponse>

export interface RemoteImageDomainDeps {
  storage: Pick<YachiyoStorage, 'getThread' | 'listThreadMessages' | 'updateMessage'>
  fetchRemoteImage: RemoteImageFetcher
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^_+|_+$/g, '') || 'image'
}

function extForContentType(contentType: string): string {
  const key = contentType.split(';')[0]!.trim().toLowerCase()
  return CONTENT_TYPE_TO_EXT[key] ?? '.bin'
}

export function deriveDownloadFilename(url: string, contentType: string): string {
  const fallbackExt = extForContentType(contentType)
  try {
    const parsed = new URL(url)
    const last = parsed.pathname.split('/').filter(Boolean).pop() ?? ''
    if (last) {
      const decoded = decodeURIComponent(last)
      const cleaned = sanitizeFilename(decoded)
      const existingExt = extname(cleaned).toLowerCase()
      if (existingExt && CONTENT_TYPE_TO_EXT[`image/${existingExt.slice(1)}`]) {
        return cleaned
      }
      const base = cleaned.replace(/\.[^.]+$/, '')
      return `${base || 'image'}${fallbackExt}`
    }
  } catch {
    /* fall through */
  }
  return `image${fallbackExt}`
}

async function ensureUniquePath(dir: string, filename: string): Promise<string> {
  const ext = extname(filename)
  const base = basename(filename, ext)
  let candidate = join(dir, filename)
  let counter = 1
  while (true) {
    try {
      await access(candidate)
      candidate = join(dir, `${base}-${counter}${ext}`)
      counter += 1
    } catch {
      return candidate
    }
  }
}

function resolveAttachmentDir(thread: ThreadRecord, messageId: string): string {
  const workspace = thread.workspacePath
  if (workspace && workspace.trim().length > 0) {
    return join(workspace, WORKSPACE_ATTACHMENT_SUBDIR, DATADIR_ATTACHMENT_SUBDIR, messageId)
  }
  return join(resolveYachiyoDataDir(), DATADIR_ATTACHMENT_SUBDIR, messageId)
}

interface MarkdownImageDestination {
  /** Position of the `<` (wrapped form) or first URL char (bare form). */
  destStart: number
  /** Position immediately after the `>` (wrapped form) or last URL char (bare form). */
  destEnd: number
  /** The extracted URL with any wrapping angle brackets removed. */
  url: string
}

/**
 * Find the end of a markdown image's alt text starting at `altStart`
 * (the first char after `![`). Handles nested balanced brackets and
 * backslash-escaped brackets, per CommonMark link-text rules.
 * Returns the index of the matching `]`, or -1 if unbalanced.
 */
function findAltTextEnd(content: string, altStart: number): number {
  let depth = 1
  let i = altStart
  while (i < content.length) {
    const ch = content[i]
    if (ch === '\\' && i + 1 < content.length) {
      // Skip escaped char (e.g. `\]` inside alt text).
      i += 2
      continue
    }
    if (ch === '[') depth += 1
    else if (ch === ']') {
      depth -= 1
      if (depth === 0) return i
    }
    i += 1
  }
  return -1
}

/**
 * Walk `content` and yield every markdown image destination we can find.
 *
 * Handles:
 *  - Alt text containing nested or escaped brackets: `![plot [v2]](url)`,
 *    `![a\]b](url)` — CommonMark allows balanced brackets and escapes.
 *  - Angle-bracket form destination: `![alt](<url>)` — URL may contain
 *    spaces, parens, backslashes, whatever, except `<`, `>`, or newlines.
 *  - Bare form destination: `![alt](url)` — URL may not contain whitespace,
 *    and parens must be balanced so `a_(1).png` parses as one URL.
 *  - Optional title after destination: `![alt](url "title")`.
 *
 * This is a character-scanning implementation because the previous
 * regex-based version could not express either the nested-bracket alt
 * text rule or the balanced-paren destination rule.
 */
function findMarkdownImageDestinations(content: string): MarkdownImageDestination[] {
  const results: MarkdownImageDestination[] = []
  let i = 0

  while (i < content.length) {
    // Look for the start of an image: `![`.
    if (content[i] !== '!' || content[i + 1] !== '[') {
      i += 1
      continue
    }

    const altEnd = findAltTextEnd(content, i + 2)
    if (altEnd < 0 || content[altEnd + 1] !== '(') {
      i += 1
      continue
    }

    const afterOpen = altEnd + 2
    let destStart: number
    let destEnd: number
    let url: string

    if (content[afterOpen] === '<') {
      // Angle-bracket form. Destination ends at the next `>` on the same line.
      destStart = afterOpen
      let close = -1
      for (let j = afterOpen + 1; j < content.length; j += 1) {
        const ch = content[j]
        if (ch === '\n') break
        if (ch === '>') {
          close = j
          break
        }
      }
      if (close < 0) {
        i += 1
        continue
      }
      url = content.slice(afterOpen + 1, close)
      destEnd = close + 1
    } else {
      // Bare form. Track paren balance so URLs like `a_(1).png` work.
      destStart = afterOpen
      let j = afterOpen
      let depth = 0
      while (j < content.length) {
        const ch = content[j]
        if (ch === ' ' || ch === '\t' || ch === '\n') break
        if (ch === '(') depth += 1
        else if (ch === ')') {
          if (depth === 0) break
          depth -= 1
        }
        j += 1
      }
      url = content.slice(afterOpen, j)
      destEnd = j
    }

    results.push({ destStart, destEnd, url })
    // Resume scanning after this image's destination to avoid
    // re-matching overlapping `![` inside the URL.
    i = destEnd
  }

  return results
}

/**
 * Wrap a local path as an angle-bracketed markdown destination so that
 * spaces, parens, and Windows backslashes round-trip through the parser.
 * `>` / `<` / newline must be escaped because they terminate the form.
 */
function formatLocalDestination(path: string): string {
  const escaped = path.replace(/[<>\n]/g, (ch) => `\\${ch}`)
  return `<${escaped}>`
}

/**
 * Replace every markdown image occurrence whose destination URL equals
 * `targetUrl` with the given replacement path. The replacement is always
 * emitted in angle-bracket form so a local path containing spaces, parens
 * or backslashes survives re-parsing. Regular markdown links `[text](url)`
 * are left untouched even when they share the URL.
 *
 * Exported for tests.
 */
export function replaceMarkdownImageUrl(
  content: string,
  targetUrl: string,
  replacement: string
): { content: string; replaced: number } {
  const destinations = findMarkdownImageDestinations(content)
  const matches = destinations.filter((d) => d.url === targetUrl)
  if (matches.length === 0) return { content, replaced: 0 }

  const wrapped = formatLocalDestination(replacement)
  let result = ''
  let cursor = 0
  for (const m of matches) {
    result += content.slice(cursor, m.destStart)
    result += wrapped
    cursor = m.destEnd
  }
  result += content.slice(cursor)
  return { content: result, replaced: matches.length }
}

/**
 * Apply `replaceMarkdownImageUrl` across every user-visible text field of a
 * message: `content`, each `textBlocks[i].content`, and `visibleReply`.
 *
 * The message timeline prefers `textBlocks[].content` over `content` when
 * present (see MessageTimeline.tsx); rewriting only `content` leaves the
 * display stuck on the original URL after a re-render, so we must rewrite
 * every field that any renderer might read.
 *
 * Exported for tests.
 */
export function rewriteMessageImageUrl(
  message: MessageRecord,
  targetUrl: string,
  replacement: string
): { message: MessageRecord; replaced: number } {
  let replaced = 0

  const contentResult = replaceMarkdownImageUrl(message.content, targetUrl, replacement)
  replaced += contentResult.replaced

  let nextTextBlocks = message.textBlocks
  if (message.textBlocks && message.textBlocks.length > 0) {
    let blocksChanged = false
    const patched = message.textBlocks.map((block) => {
      const result = replaceMarkdownImageUrl(block.content, targetUrl, replacement)
      if (result.replaced > 0) {
        replaced += result.replaced
        blocksChanged = true
        return { ...block, content: result.content }
      }
      return block
    })
    if (blocksChanged) nextTextBlocks = patched
  }

  let nextVisibleReply = message.visibleReply
  if (typeof message.visibleReply === 'string' && message.visibleReply.length > 0) {
    const result = replaceMarkdownImageUrl(message.visibleReply, targetUrl, replacement)
    if (result.replaced > 0) {
      replaced += result.replaced
      nextVisibleReply = result.content
    }
  }

  return {
    message: {
      ...message,
      content: contentResult.content,
      textBlocks: nextTextBlocks,
      visibleReply: nextVisibleReply
    },
    replaced
  }
}

export function createRemoteImageDomain(deps: RemoteImageDomainDeps): {
  downloadRemoteImageForMessage(input: DownloadRemoteImageInput): Promise<{
    message: MessageRecord
    absPath: string
  }>
} {
  return {
    async downloadRemoteImageForMessage(input) {
      const { threadId, messageId, url } = input

      const thread = deps.storage.getThread(threadId)
      if (!thread) throw new Error(`Unknown thread: ${threadId}`)

      const messages = deps.storage.listThreadMessages(threadId)
      const message = messages.find((m) => m.id === messageId)
      if (!message) throw new Error(`Unknown message: ${messageId}`)
      if (message.role !== 'assistant') {
        throw new Error('Only assistant messages support image download')
      }

      if (!messageContainsUrl(message, url)) {
        throw new Error('Image URL not found in message content')
      }

      const response = await deps.fetchRemoteImage(url)
      if (!response.contentType.toLowerCase().startsWith('image/')) {
        throw new Error(`Not an image (content-type: ${response.contentType})`)
      }

      const dir = resolveAttachmentDir(thread, messageId)
      await mkdir(dir, { recursive: true })

      const filename = deriveDownloadFilename(url, response.contentType)
      const absPath = await ensureUniquePath(dir, filename)
      await writeFile(absPath, response.bytes)

      const { message: updated, replaced } = rewriteMessageImageUrl(message, url, absPath)
      if (replaced === 0) {
        throw new Error('Image URL not found in markdown image syntax')
      }

      deps.storage.updateMessage(updated)

      return { message: updated, absPath }
    }
  }
}

function messageContainsUrl(message: MessageRecord, url: string): boolean {
  if (message.content.includes(url)) return true
  if (message.textBlocks?.some((block) => block.content.includes(url))) return true
  if (typeof message.visibleReply === 'string' && message.visibleReply.includes(url)) return true
  return false
}
