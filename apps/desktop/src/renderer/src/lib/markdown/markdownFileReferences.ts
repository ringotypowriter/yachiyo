import type { Link, Root } from 'mdast'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import { visit } from 'unist-util-visit'

import { toInlineCodeFileReferenceCandidate } from '@yachiyo/shared/inlineCodeFileReferences'

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
    if (references.length >= maxReferences) return
    const reference = toInlineCodeFileReferenceCandidate(node.url)
    if (!reference || seen.has(reference)) return
    seen.add(reference)
    references.push(reference)
  })

  return references
}
