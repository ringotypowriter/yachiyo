import { tool, type Tool } from 'ai'

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

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
  resolvePathWithinWorkspace,
  textContent,
  toToolModelOutput,
  webReadToolInputSchema
} from './shared.ts'

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

  if (details.truncated) {
    const originalChars = details.originalContentChars ?? details.contentChars
    lines.push('', `[truncated from ${originalChars} to ${details.contentChars} characters]`)
  }

  return lines.join('\n')
}

function buildSavedWebReadModelContent(details: WebReadToolCallDetails): string {
  const lines = [
    `Saved readable content to ${details.savedFilePath ?? details.savedFileName ?? 'workspace file'}.`,
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
    (details.savedFilePath || details.savedFileName
      ? buildSavedWebReadModelContent(details)
      : buildWebReadModelContent(details))

  return {
    content: textContent(message),
    details,
    ...(error ? { error } : {}),
    metadata: {
      ...(details.truncated ? { truncated: true } : {})
    }
  }
}

export function createTool(
  context: AgentToolContext,
  dependencies: WebReadServiceDependencies = {}
): Tool<WebReadToolInput, WebReadToolOutput> {
  return tool({
    description:
      'Fetch a static HTTP(S) web page and extract its main readable content. Use it for articles, documentation pages, or other server-rendered content. If filename is provided, save the extracted content under the current workspace instead of returning the full content to the model. Do not use it for browser automation, login flows, or JS-heavy apps.',
    inputSchema: webReadToolInputSchema,
    toModelOutput: ({ output }) => toToolModelOutput(output),
    execute: (input, options) =>
      runWebReadTool(input, context, {
        ...dependencies,
        signal: options.abortSignal
      })
  })
}

function createWebReadFailureDetails(input: {
  requestedUrl: string
  contentFormat: WebReadToolCallDetails['contentFormat']
  errorCode: NonNullable<WebReadToolCallDetails['failureCode']>
  savedFileName?: string
  savedFilePath?: string
}): WebReadToolCallDetails {
  return {
    requestedUrl: input.requestedUrl,
    extractor: 'none',
    content: '',
    contentFormat: input.contentFormat,
    contentChars: 0,
    truncated: false,
    failureCode: input.errorCode,
    ...(input.savedFileName ? { savedFileName: input.savedFileName } : {}),
    ...(input.savedFilePath ? { savedFilePath: input.savedFilePath } : {})
  }
}

function resolveWebReadSaveTarget(
  workspacePath: string,
  filename: string
):
  | {
      savedFileName: string
      savedFilePath: string
    }
  | undefined {
  const normalizedFilename = filename.trim()
  if (!normalizedFilename) {
    return undefined
  }

  const savedFilePath = resolvePathWithinWorkspace(workspacePath, normalizedFilename)
  if (!savedFilePath) {
    return undefined
  }

  return {
    savedFileName: normalizedFilename,
    savedFilePath
  }
}

export async function runWebReadTool(
  input: WebReadToolInput,
  context: AgentToolContext,
  dependencies: WebReadServiceDependencies & {
    signal?: AbortSignal
  } = {}
): Promise<WebReadToolOutput> {
  const saveTarget =
    input.filename === undefined
      ? undefined
      : resolveWebReadSaveTarget(context.workspacePath, input.filename)

  if (input.filename !== undefined && !saveTarget) {
    return createWebReadResult(
      createWebReadFailureDetails({
        requestedUrl: input.url,
        contentFormat: input.format ?? DEFAULT_WEB_READ_FORMAT,
        errorCode: 'invalid-filename'
      }),
      'filename must stay within the current workspace.'
    )
  }

  const result = await readWebPage(
    {
      url: input.url,
      format: input.format ?? DEFAULT_WEB_READ_FORMAT,
      ...(saveTarget ? { maxContentChars: null } : {}),
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
    truncated: result.truncated,
    ...(result.originalContentChars === undefined
      ? {}
      : { originalContentChars: result.originalContentChars }),
    ...(saveTarget?.savedFileName ? { savedFileName: saveTarget.savedFileName } : {}),
    ...(saveTarget?.savedFilePath ? { savedFilePath: saveTarget.savedFilePath } : {}),
    ...(result.failureCode ? { failureCode: result.failureCode } : {})
  }

  if (result.error) {
    return createWebReadResult(baseDetails, result.error)
  }

  if (!saveTarget) {
    return createWebReadResult(baseDetails)
  }

  try {
    await mkdir(dirname(saveTarget.savedFilePath), { recursive: true })
    await writeFile(saveTarget.savedFilePath, result.content, 'utf8')

    return createWebReadResult({
      ...baseDetails,
      content: '',
      truncated: false,
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
