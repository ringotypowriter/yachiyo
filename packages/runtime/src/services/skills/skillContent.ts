import { resolve } from 'node:path'

const MARKDOWN_LINK_RE = /(!?\[[^\]]*\])\(([^)]+)\)/gu

function isExternalUrl(url: string): boolean {
  return (
    url.startsWith('http://') ||
    url.startsWith('https://') ||
    url.startsWith('ftp://') ||
    url.startsWith('mailto:') ||
    url.startsWith('#') ||
    url.startsWith('/') ||
    url.startsWith('data:')
  )
}

function stripMarkdownLinkWrappers(url: string): string {
  let result = url.trim()
  if (result.startsWith('<') && result.endsWith('>')) {
    result = result.slice(1, -1).trim()
  }
  if (
    (result.startsWith('"') && result.endsWith('"')) ||
    (result.startsWith("'") && result.endsWith("'"))
  ) {
    result = result.slice(1, -1).trim()
  }
  return result
}

/**
 * Rewrite relative markdown links and image references in skill content to
 * absolute paths so the agent can resolve them correctly against the skill
 * directory instead of the current workspace.
 */
export function rewriteRelativeMarkdownLinks(content: string, baseDirectory: string): string {
  return content.replace(MARKDOWN_LINK_RE, (match, prefix: string, rawUrl: string) => {
    const url = stripMarkdownLinkWrappers(rawUrl)
    if (!url || isExternalUrl(url)) {
      return match
    }
    const absoluteUrl = resolve(baseDirectory, url).replace(/\\/gu, '/')
    return `${prefix}(${absoluteUrl})`
  })
}
