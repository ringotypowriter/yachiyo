import {
  DEFAULT_WEB_READ_CONTENT_FORMAT,
  type WebReadContentFormat,
  type WebReadExtractor,
  type WebReadFailureCode
} from '../../../../shared/yachiyo/protocol.ts'
import {
  extractWithDefuddle,
  type WebReadableExtraction,
  type WebReadableExtractor
} from './defuddleExtractor.ts'

const DEFAULT_WEB_READ_TIMEOUT_MS = 12_000
const MAX_WEB_READ_RESPONSE_BYTES = 10_000_000
const MAX_WEB_READ_CONTENT_CHARS = 32_000
const HTML_CONTENT_TYPES = ['text/html', 'application/xhtml+xml']
const WEB_READ_ACCEPT_HEADER =
  'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8'
const WEB_READ_ACCEPT_LANGUAGE_HEADER = 'en-US,en;q=0.9'
const WEB_READ_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36'
const FALLBACK_STRIP_SELECTORS =
  'script, style, noscript, template, nav, footer, header, aside, form, button'

type LinkedomDocument = Document & {
  URL?: string
  defaultView?: (Window & Record<string, unknown>) | null
}
type LinkedomElement = NonNullable<LinkedomDocument['body']>
type FetchImplementation = typeof fetch
type LinkedomModule = {
  parseHTML: (html: string) => {
    document: LinkedomDocument
    window: Window & Record<string, unknown>
  }
}

let linkedomModulePromise: Promise<LinkedomModule> | undefined

export interface WebReadRequest {
  format?: WebReadContentFormat
  maxContentChars?: number | null
  signal?: AbortSignal
  url: string
}

export interface WebReadServiceResult {
  requestedUrl: string
  finalUrl?: string
  httpStatus?: number
  contentType?: string
  extractor: WebReadExtractor
  title?: string
  author?: string
  siteName?: string
  publishedTime?: string
  description?: string
  content: string
  contentFormat: WebReadContentFormat
  contentChars: number
  truncated: boolean
  originalContentChars?: number
  failureCode?: WebReadFailureCode
  error?: string
}

export interface WebReadServiceDependencies {
  extractReadableContent?: WebReadableExtractor
  fetchImpl?: FetchImplementation
}

function normalizeOptionalText(value: string | null | undefined): string | undefined {
  const normalized = value?.replace(/\r\n/g, '\n').trim()
  return normalized ? normalized : undefined
}

function createFailureResult(input: {
  requestedUrl: string
  format: WebReadContentFormat
  error: string
  failureCode: WebReadFailureCode
  finalUrl?: string
  httpStatus?: number
  contentType?: string
}): WebReadServiceResult {
  return {
    requestedUrl: input.requestedUrl,
    ...(input.finalUrl ? { finalUrl: input.finalUrl } : {}),
    ...(input.httpStatus === undefined ? {} : { httpStatus: input.httpStatus }),
    ...(input.contentType ? { contentType: input.contentType } : {}),
    extractor: 'none',
    content: '',
    contentFormat: input.format,
    contentChars: 0,
    truncated: false,
    failureCode: input.failureCode,
    error: input.error
  }
}

function parseRequestedUrl(value: string): URL | WebReadServiceResult {
  const requestedUrl = value.trim()

  try {
    const url = new URL(requestedUrl)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return createFailureResult({
        requestedUrl,
        format: DEFAULT_WEB_READ_CONTENT_FORMAT,
        error: `Unsupported URL protocol: ${url.protocol}`,
        failureCode: 'unsupported-protocol'
      })
    }

    return url
  } catch {
    return createFailureResult({
      requestedUrl,
      format: DEFAULT_WEB_READ_CONTENT_FORMAT,
      error: 'Invalid URL. Use a full http:// or https:// URL.',
      failureCode: 'invalid-url'
    })
  }
}

function buildRequestSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
}

function buildDocumentRequestHeaders(): Headers {
  return new Headers({
    Accept: WEB_READ_ACCEPT_HEADER,
    'Accept-Language': WEB_READ_ACCEPT_LANGUAGE_HEADER,
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1',
    'User-Agent': WEB_READ_USER_AGENT
  })
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.name === 'TimeoutError'
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function getContentTypeHeader(headers: Headers): string | undefined {
  return normalizeOptionalText(headers.get('content-type'))
}

function parseCharset(contentType?: string): string | undefined {
  const match = /charset=([^;]+)/i.exec(contentType ?? '')
  return match ? match[1]?.trim().toLowerCase() : undefined
}

function createDecoder(contentType?: string): TextDecoder {
  const charset = parseCharset(contentType)

  if (!charset) {
    return new TextDecoder()
  }

  try {
    return new TextDecoder(charset)
  } catch {
    return new TextDecoder()
  }
}

function isSupportedHtmlContentType(contentType?: string): boolean {
  if (!contentType) {
    return true
  }

  const normalized = contentType.split(';')[0]?.trim().toLowerCase()
  return normalized !== undefined && HTML_CONTENT_TYPES.includes(normalized)
}

function looksLikeHtml(value: string): boolean {
  return /<(?:!doctype\s+html|html|head|body|main|article)\b/i.test(value)
}

function buildComputedStyleStub(): {
  clipPath: string
  content: string
  display: string
  getPropertyValue: (name: string) => string
  opacity: string
  position: string
  visibility: string
} {
  const style = {
    clipPath: 'none',
    content: '',
    display: 'block',
    getPropertyValue: () => '',
    opacity: '1',
    position: 'static',
    visibility: 'visible'
  }

  return new Proxy(style, {
    get(target, property) {
      if (property in target) {
        return target[property as keyof typeof target]
      }

      return ''
    }
  })
}

async function loadLinkedomModule(): Promise<LinkedomModule> {
  if (!linkedomModulePromise) {
    linkedomModulePromise = import('linkedom/worker') as unknown as Promise<LinkedomModule>
  }

  return linkedomModulePromise
}

async function createParsedDocument(html: string): Promise<LinkedomDocument> {
  const { parseHTML } = await loadLinkedomModule()
  const { document, window } = parseHTML(html)

  if (typeof window.getComputedStyle !== 'function') {
    const getComputedStyle = (): ReturnType<typeof buildComputedStyleStub> =>
      buildComputedStyleStub()
    Object.assign(window, { getComputedStyle })
    Object.assign(document.defaultView ?? {}, { getComputedStyle })
  }

  return document
}

async function readResponseHtml(response: Response, contentType?: string): Promise<string> {
  if (!response.body) {
    throw new Error('Response body was empty.')
  }

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  const decoder = createDecoder(contentType)
  let totalBytes = 0

  while (true) {
    const { done, value } = await reader.read()
    if (done) {
      break
    }

    totalBytes += value.byteLength
    if (totalBytes > MAX_WEB_READ_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined)
      throw new Error(`Response exceeded ${MAX_WEB_READ_RESPONSE_BYTES} bytes.`)
    }

    chunks.push(value)
  }

  return chunks.map((chunk) => decoder.decode(chunk, { stream: true })).join('') + decoder.decode()
}

function readMetaContent(document: LinkedomDocument, selector: string): string | undefined {
  const value = document.querySelector(selector)?.getAttribute('content')
  return normalizeOptionalText(value)
}

function readDocumentMetadata(
  document: LinkedomDocument,
  pageUrl: string
): Omit<WebReadableExtraction, 'content' | 'extractor'> {
  const hostname = (() => {
    try {
      return new URL(pageUrl).hostname
    } catch {
      return undefined
    }
  })()

  return {
    ...(normalizeOptionalText(document.title)
      ? { title: normalizeOptionalText(document.title) }
      : {}),
    ...(readMetaContent(document, 'meta[name="author"], meta[property="article:author"]')
      ? {
          author: readMetaContent(document, 'meta[name="author"], meta[property="article:author"]')
        }
      : {}),
    ...(readMetaContent(document, 'meta[property="og:site_name"]') || hostname
      ? {
          siteName:
            readMetaContent(document, 'meta[property="og:site_name"]') ??
            normalizeOptionalText(hostname)
        }
      : {}),
    ...(readMetaContent(document, 'meta[property="article:published_time"], meta[name="pubdate"]')
      ? {
          publishedTime: readMetaContent(
            document,
            'meta[property="article:published_time"], meta[name="pubdate"]'
          )
        }
      : {}),
    ...(readMetaContent(document, 'meta[name="description"], meta[property="og:description"]')
      ? {
          description: readMetaContent(
            document,
            'meta[name="description"], meta[property="og:description"]'
          )
        }
      : {})
  }
}

function findFallbackRoot(document: LinkedomDocument): LinkedomElement | null {
  return (
    document.querySelector('article') ??
    document.querySelector('main') ??
    document.body ??
    document.documentElement ??
    null
  )
}

function cloneForFallback(root: LinkedomElement): LinkedomElement {
  const clone = root.cloneNode(true) as LinkedomElement
  for (const element of clone.querySelectorAll(FALLBACK_STRIP_SELECTORS)) {
    element.remove()
  }

  return clone
}

function normalizePlainText(value: string): string {
  return value
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

function extractFallbackContent(
  document: LinkedomDocument,
  format: WebReadContentFormat
): WebReadableExtraction | undefined {
  const root = findFallbackRoot(document)
  if (!root) {
    return undefined
  }

  const clone = cloneForFallback(root)
  const content =
    format === 'html'
      ? (normalizeOptionalText(clone.innerHTML) ?? '')
      : normalizePlainText(clone.textContent ?? '')

  if (!content) {
    return undefined
  }

  return {
    extractor: 'linkedom-fallback',
    ...readDocumentMetadata(document, document.URL ?? 'about:blank'),
    content
  }
}

function chooseMetadataValue(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => value !== undefined)
}

function truncateContent(
  content: string,
  maxContentChars: number | null = MAX_WEB_READ_CONTENT_CHARS
): {
  content: string
  contentChars: number
  truncated: boolean
  originalContentChars?: number
} {
  const normalized = content.trim()

  if (maxContentChars === null || normalized.length <= maxContentChars) {
    return {
      content: normalized,
      contentChars: normalized.length,
      truncated: false
    }
  }

  const truncatedContent = normalized.slice(0, maxContentChars).trimEnd()

  return {
    content: truncatedContent,
    contentChars: truncatedContent.length,
    truncated: true,
    originalContentChars: normalized.length
  }
}

function mapResult(input: {
  requestedUrl: string
  finalUrl: string
  httpStatus: number
  contentType?: string
  format: WebReadContentFormat
  extracted: WebReadableExtraction
  fallbackMetadata: Omit<WebReadableExtraction, 'content' | 'extractor'>
  maxContentChars?: number | null
}): WebReadServiceResult {
  const truncated = truncateContent(input.extracted.content, input.maxContentChars)

  return {
    requestedUrl: input.requestedUrl,
    finalUrl: input.finalUrl,
    httpStatus: input.httpStatus,
    ...(input.contentType ? { contentType: input.contentType } : {}),
    extractor: input.extracted.extractor,
    ...(chooseMetadataValue(input.extracted.title, input.fallbackMetadata.title)
      ? { title: chooseMetadataValue(input.extracted.title, input.fallbackMetadata.title) }
      : {}),
    ...(chooseMetadataValue(input.extracted.author, input.fallbackMetadata.author)
      ? { author: chooseMetadataValue(input.extracted.author, input.fallbackMetadata.author) }
      : {}),
    ...(chooseMetadataValue(input.extracted.siteName, input.fallbackMetadata.siteName)
      ? {
          siteName: chooseMetadataValue(input.extracted.siteName, input.fallbackMetadata.siteName)
        }
      : {}),
    ...(chooseMetadataValue(input.extracted.publishedTime, input.fallbackMetadata.publishedTime)
      ? {
          publishedTime: chooseMetadataValue(
            input.extracted.publishedTime,
            input.fallbackMetadata.publishedTime
          )
        }
      : {}),
    ...(chooseMetadataValue(input.extracted.description, input.fallbackMetadata.description)
      ? {
          description: chooseMetadataValue(
            input.extracted.description,
            input.fallbackMetadata.description
          )
        }
      : {}),
    content: truncated.content,
    contentFormat: input.format,
    contentChars: truncated.contentChars,
    truncated: truncated.truncated,
    ...(truncated.originalContentChars === undefined
      ? {}
      : { originalContentChars: truncated.originalContentChars })
  }
}

export async function readWebPage(
  request: WebReadRequest,
  dependencies: WebReadServiceDependencies = {}
): Promise<WebReadServiceResult> {
  const format = request.format ?? DEFAULT_WEB_READ_CONTENT_FORMAT
  const parsedUrl = parseRequestedUrl(request.url)
  if (parsedUrl instanceof URL === false) {
    return {
      ...parsedUrl,
      contentFormat: format
    }
  }

  const fetchImpl = dependencies.fetchImpl ?? fetch
  const extractReadableContent = dependencies.extractReadableContent ?? extractWithDefuddle
  const requestedUrl = parsedUrl.toString()

  let response: Response

  try {
    response = await fetchImpl(requestedUrl, {
      headers: buildDocumentRequestHeaders(),
      redirect: 'follow',
      signal: buildRequestSignal(DEFAULT_WEB_READ_TIMEOUT_MS, request.signal)
    })
  } catch (error) {
    const failureCode = isTimeoutError(error)
      ? 'timeout'
      : isAbortError(error) && request.signal?.aborted
        ? 'fetch-failed'
        : isAbortError(error)
          ? 'timeout'
          : 'fetch-failed'
    const message =
      failureCode === 'timeout'
        ? `Timed out while fetching ${requestedUrl}.`
        : error instanceof Error
          ? `Failed to fetch ${requestedUrl}: ${error.message}`
          : `Failed to fetch ${requestedUrl}.`

    return createFailureResult({
      requestedUrl,
      format,
      error: message,
      failureCode
    })
  }

  const finalUrl = normalizeOptionalText(response.url) ?? requestedUrl
  const httpStatus = response.status
  const contentType = getContentTypeHeader(response.headers)

  if (!response.ok) {
    return createFailureResult({
      requestedUrl,
      format,
      finalUrl,
      httpStatus,
      contentType,
      error: `HTTP ${httpStatus} while fetching ${finalUrl}.`,
      failureCode: 'http-error'
    })
  }

  if (!isSupportedHtmlContentType(contentType)) {
    return createFailureResult({
      requestedUrl,
      format,
      finalUrl,
      httpStatus,
      contentType,
      error: `Unsupported content type: ${contentType}. webRead only supports static HTML pages.`,
      failureCode: 'unsupported-content-type'
    })
  }

  let html: string
  try {
    html = await readResponseHtml(response, contentType)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to read response body.'
    const failureCode = /Response exceeded/i.test(message)
      ? 'response-too-large'
      : isTimeoutError(error) || isAbortError(error)
        ? 'timeout'
        : 'empty-body'
    const errorMessage =
      failureCode === 'timeout'
        ? `Timed out while reading response body from ${finalUrl}.`
        : message

    return createFailureResult({
      requestedUrl,
      format,
      finalUrl,
      httpStatus,
      contentType,
      error: errorMessage,
      failureCode
    })
  }

  if (!html.trim()) {
    return createFailureResult({
      requestedUrl,
      format,
      finalUrl,
      httpStatus,
      contentType,
      error: `Fetched ${finalUrl} but the response body was empty.`,
      failureCode: 'empty-body'
    })
  }

  if (!looksLikeHtml(html)) {
    return createFailureResult({
      requestedUrl,
      format,
      finalUrl,
      httpStatus,
      contentType,
      error: `Fetched ${finalUrl} but the response did not look like HTML.`,
      failureCode: 'unsupported-content-type'
    })
  }

  const document = await createParsedDocument(html)
  const fallbackMetadata = readDocumentMetadata(document, finalUrl)
  let extractorFailed = false

  try {
    const extracted = await extractReadableContent(document, finalUrl, format)
    if (normalizeOptionalText(extracted.content)) {
      return mapResult({
        requestedUrl,
        finalUrl,
        httpStatus,
        contentType,
        format,
        extracted: {
          ...extracted,
          content: normalizeOptionalText(extracted.content) ?? ''
        },
        fallbackMetadata,
        ...(request.maxContentChars === undefined
          ? {}
          : { maxContentChars: request.maxContentChars })
      })
    }
  } catch {
    extractorFailed = true
    // Fall through to the bounded linkedom fallback below.
  }

  const fallback = extractFallbackContent(document, format)
  if (fallback) {
    return mapResult({
      requestedUrl,
      finalUrl,
      httpStatus,
      contentType,
      format,
      extracted: fallback,
      fallbackMetadata,
      ...(request.maxContentChars === undefined ? {} : { maxContentChars: request.maxContentChars })
    })
  }

  return createFailureResult({
    requestedUrl,
    format,
    finalUrl,
    httpStatus,
    contentType,
    error: `Unable to extract readable content from ${finalUrl}.`,
    failureCode: extractorFailed ? 'extraction-failed' : 'empty-content'
  })
}
