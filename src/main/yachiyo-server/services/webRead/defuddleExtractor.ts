import type { WebReadContentFormat, WebReadExtractor } from '../../../../shared/yachiyo/protocol.ts'

type LinkedomDocument = {
  URL?: string
}

interface DefuddleLikeResponse {
  title?: string
  author?: string
  site?: string
  published?: string
  description?: string
  content?: string
}

interface DefuddleNodeModule {
  Defuddle: (
    input: unknown,
    url?: string,
    options?: {
      markdown?: boolean
      useAsync?: boolean
    }
  ) => Promise<DefuddleLikeResponse>
}

export interface WebReadableExtraction {
  author?: string
  content: string
  description?: string
  extractor: Exclude<WebReadExtractor, 'none'>
  publishedTime?: string
  siteName?: string
  title?: string
}

export type WebReadableExtractor = (
  document: LinkedomDocument,
  url: string,
  format: WebReadContentFormat
) => Promise<WebReadableExtraction>

let defuddleNodeModulePromise: Promise<DefuddleNodeModule> | undefined

function normalizeOptionalText(value: string | undefined): string | undefined {
  const normalized = value?.replace(/\r\n/g, '\n').trim()
  return normalized ? normalized : undefined
}

async function loadDefuddleNodeModule(): Promise<DefuddleNodeModule> {
  if (!defuddleNodeModulePromise) {
    defuddleNodeModulePromise = import('defuddle/node') as Promise<DefuddleNodeModule>
  }

  return defuddleNodeModulePromise
}

export const extractWithDefuddle: WebReadableExtractor = async (document, url, format) => {
  const { Defuddle } = await loadDefuddleNodeModule()
  const result = await Defuddle(document, url, {
    markdown: format === 'markdown',
    useAsync: false
  })

  return {
    extractor: 'defuddle',
    ...(normalizeOptionalText(result.title) ? { title: normalizeOptionalText(result.title) } : {}),
    ...(normalizeOptionalText(result.author)
      ? { author: normalizeOptionalText(result.author) }
      : {}),
    ...(normalizeOptionalText(result.site) ? { siteName: normalizeOptionalText(result.site) } : {}),
    ...(normalizeOptionalText(result.published)
      ? { publishedTime: normalizeOptionalText(result.published) }
      : {}),
    ...(normalizeOptionalText(result.description)
      ? { description: normalizeOptionalText(result.description) }
      : {}),
    content: normalizeOptionalText(result.content) ?? ''
  }
}
