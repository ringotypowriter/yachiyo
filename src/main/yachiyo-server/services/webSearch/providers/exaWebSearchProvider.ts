import type { SettingsConfig, WebSearchResultItem } from '../../../../../shared/yachiyo/protocol.ts'
import type { WebSearchProvider, WebSearchResult } from '../webSearchService.ts'

const EXA_API_BASE = 'https://api.exa.ai'
const EXA_SNIPPET_MAX_CHARS = 512

interface ExaSearchResultItem {
  id: string
  url: string
  title?: string
  text?: string
  score?: number
}

interface ExaSearchResponse {
  results: ExaSearchResultItem[]
}

export function createExaWebSearchProvider(input: {
  readConfig: () => SettingsConfig
  fetchImpl?: typeof globalThis.fetch
}): WebSearchProvider {
  const fetchFn = input.fetchImpl ?? globalThis.fetch.bind(globalThis)

  return {
    id: 'exa',

    async search({ limit, query, signal }): Promise<WebSearchResult> {
      const config = input.readConfig()
      const exaConfig = config.webSearch?.exa
      const apiKey = exaConfig?.apiKey?.trim() ?? ''
      const baseUrl = exaConfig?.baseUrl?.trim().replace(/\/$/, '') || EXA_API_BASE

      if (!apiKey) {
        return {
          provider: 'exa',
          query,
          results: [],
          failureCode: 'provider-failed',
          error: 'Exa API key is not configured.'
        }
      }

      let response: Response

      try {
        response = await fetchFn(`${baseUrl}/search`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey
          },
          body: JSON.stringify({
            query,
            numResults: limit,
            contents: { text: { maxCharacters: EXA_SNIPPET_MAX_CHARS } }
          }),
          signal
        })
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          return {
            provider: 'exa',
            query,
            results: [],
            failureCode: 'aborted',
            error: 'web search was aborted.'
          }
        }
        return {
          provider: 'exa',
          query,
          results: [],
          failureCode: 'provider-failed',
          error: error instanceof Error ? error.message : 'Exa search request failed.'
        }
      }

      if (!response.ok) {
        const body = await response.text().catch(() => '')
        return {
          provider: 'exa',
          query,
          results: [],
          failureCode: 'provider-failed',
          error: `Exa API error ${response.status}${body ? `: ${body}` : ''}`
        }
      }

      let data: ExaSearchResponse

      try {
        data = (await response.json()) as ExaSearchResponse
      } catch {
        return {
          provider: 'exa',
          query,
          results: [],
          failureCode: 'extraction-failed',
          error: 'Failed to parse Exa API response.'
        }
      }

      const results: WebSearchResultItem[] = data.results.map((item, index) => ({
        title: item.title ?? item.url,
        url: item.url,
        ...(item.text?.trim() ? { snippet: item.text.trim() } : {}),
        rank: index + 1
      }))

      return { provider: 'exa', query, results }
    }
  }
}
