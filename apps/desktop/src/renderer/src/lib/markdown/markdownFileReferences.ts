import type { Link, Root } from 'mdast'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import { visit } from 'unist-util-visit'

import { toMarkdownDestinationCandidates } from '@yachiyo/shared/inlineCodeFileReferences'

const DEFAULT_MAX_MARKDOWN_FILE_REFERENCES = 64
const markdownParser = unified().use(remarkParse)

export function extractMarkdownFileReferences(
  markdown: string,
  maxReferences = DEFAULT_MAX_MARKDOWN_FILE_REFERENCES
): string[] {
  const references: string[] = []
  const seen = new Set<string>()
  const tree = markdownParser.parse(markdown) as Root

  visit(tree, 'link', (node: Link) => {
    // The cap counts what actually goes to the resolver, and the candidates are
    // ordered so the last slot keeps the standard URI reading rather than the
    // literal fallback.
    for (const reference of toMarkdownDestinationCandidates(node.url)) {
      if (references.length >= maxReferences) return
      if (seen.has(reference)) continue
      seen.add(reference)
      references.push(reference)
    }
  })

  return references
}
