import { tool, type Tool } from 'ai'

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { WebReadToolCallDetails } from '../../../../shared/yachiyo/protocol.ts'
import {
  readWebPage,
  type WebReadServiceDependencies
} from '../../services/webRead/webReadService.ts'
import {
  DEFAULT_WEB_READ_FORMAT,
  type AgentToolContext,
  type WebReadToolInput,
  type WebReadToolOutput,
  textContent,
  toToolModelOutput,
  webReadToolInputSchema
} from './shared.ts'

const AUTO_SAVE_DIR = '.yachiyo/tool-result'
const INLINE_CONTENT_LIMIT = 32_000

function sanitizeHostname(hostname: string): string {
  return hostname
    .replace(/\./g, '-')
    .replace(/[^a-z0-9-]/gi, '')
    .toLowerCase()
}

function generateAutoSaveFilename(url: string): string {
  let hostname = 'web'
  try {
    hostname = sanitizeHostname(new URL(url).hostname) || 'web'
  } catch {
    // invalid URL — fall back to 'web' prefix
  }
  return `web-${hostname}-${Date.now()}.md`
}

function buildWebReadModelContent(details: WebReadToolCallDetails): string {
  const lines = [
    `URL: ${details.finalUrl ?? details.requestedUrl}`,
    ...(details.title ? [`Title: ${details.title}`] : []),
    ...(details.author ? [`Author: ${details.author}`] : []),
    ...(details.siteName ? [`Site: ${details.siteName}`] : []),
    ...(details.publishedTime ? [`Published: ${details.publishedTime}`] : []),
    `Format: ${details.contentFormat}`,
    `Extractor: ${details.extractor}`
  ]

  if (details.description) {
    lines.push(`Description: ${details.description}`)
  }

  lines.push('', details.content)

  return lines.join('\n')
}

function buildAutoSavedModelContent(details: WebReadToolCallDetails): string {
  const filePath = details.savedFileName ?? details.savedFilePath ?? 'workspace file'
  const lines = [
    `Content too large to inline (${details.contentChars} chars). Full content saved to ${filePath}.`,
    `Use the read tool to read it.`,
    `URL: ${details.finalUrl ?? details.requestedUrl}`,
    ...(details.title ? [`Title: ${details.title}`] : []),
    ...(details.author ? [`Author: ${details.author}`] : []),
    ...(details.siteName ? [`Site: ${details.siteName}`] : []),
    ...(details.publishedTime ? [`Published: ${details.publishedTime}`] : []),
    `Format: ${details.contentFormat}`,
    `Extractor: ${details.extractor}`,
    ...(details.savedBytes === undefined ? [] : [`Saved bytes: ${details.savedBytes}`])
  ]

  if (details.description) {
    lines.push(`Description: ${details.description}`)
  }

  return lines.join('\n')
}

function createWebReadResult(details: WebReadToolCallDetails, error?: string): WebReadToolOutput {
  const message =
    error ??
    (details.savedFileName || details.savedFilePath
      ? buildAutoSavedModelContent(details)
      : buildWebReadModelContent(details))

  return {
    content: textContent(message),
    details,
    ...(error ? { error } : {}),
    metadata: {}
  }
}

export function createTool(
  context: AgentToolContext,
  dependencies: WebReadServiceDependencies = {}
): Tool<WebReadToolInput, WebReadToolOutput> {
  return tool({
    description:
      'Fetch a static HTTP(S) resource whose response body you want to read. For HTML pages, webRead returns the main readable content in the requested format when extraction succeeds. For non-HTML text responses such as plain text or JSON, it returns the raw response body. If HTML extraction fails, it falls back to the raw response body. If the content is too large to return inline, it will be automatically saved to a workspace file and you will be instructed to read it with the read tool. Do not use it for browser automation, login flows, or JS-heavy apps.',
    inputSchema: webReadToolInputSchema,
    toModelOutput: ({ output }) => toToolModelOutput(output),
    execute: (input, options) =>
      runWebReadTool(input, context, {
        ...dependencies,
        signal: options.abortSignal
      })
  })
}

export async function runWebReadTool(
  input: WebReadToolInput,
  context: AgentToolContext,
  dependencies: WebReadServiceDependencies & {
    signal?: AbortSignal
  } = {}
): Promise<WebReadToolOutput> {
  const result = await readWebPage(
    {
      url: input.url,
      format: input.format ?? DEFAULT_WEB_READ_FORMAT,
      maxContentChars: null,
      signal: dependencies.signal
    },
    dependencies
  )

  const baseDetails: WebReadToolCallDetails = {
    requestedUrl: result.requestedUrl,
    ...(result.finalUrl ? { finalUrl: result.finalUrl } : {}),
    ...(result.httpStatus === undefined ? {} : { httpStatus: result.httpStatus }),
    ...(result.contentType ? { contentType: result.contentType } : {}),
    extractor: result.extractor,
    ...(result.title ? { title: result.title } : {}),
    ...(result.author ? { author: result.author } : {}),
    ...(result.siteName ? { siteName: result.siteName } : {}),
    ...(result.publishedTime ? { publishedTime: result.publishedTime } : {}),
    ...(result.description ? { description: result.description } : {}),
    content: result.content,
    contentFormat: result.contentFormat,
    contentChars: result.contentChars,
    truncated: false,
    ...(result.failureCode ? { failureCode: result.failureCode } : {})
  }

  if (result.error) {
    return createWebReadResult(baseDetails, result.error)
  }

  if (result.contentChars <= INLINE_CONTENT_LIMIT) {
    return createWebReadResult(baseDetails)
  }

  // Content exceeds inline limit — auto-save to .yachiyo/tool-result/
  const filename = generateAutoSaveFilename(result.requestedUrl)
  const savedFileName = join(AUTO_SAVE_DIR, filename)
  const savedFilePath = join(context.workspacePath, AUTO_SAVE_DIR, filename)

  try {
    await mkdir(join(context.workspacePath, AUTO_SAVE_DIR), { recursive: true })
    await writeFile(savedFilePath, result.content, 'utf8')

    return createWebReadResult({
      ...baseDetails,
      content: '',
      savedFileName,
      savedFilePath,
      savedBytes: Buffer.byteLength(result.content, 'utf8')
    })
  } catch (error) {
    return createWebReadResult(
      {
        ...baseDetails,
        content: '',
        failureCode: 'write-failed'
      },
      error instanceof Error ? error.message : 'Unable to save readable content to a file.'
    )
  }
}
