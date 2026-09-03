import { toMarkdownDestinationCandidates } from '@yachiyo/shared/inlineCodeFileReferences'
import type { Plugin } from 'unified'

export const WORKSPACE_FILE_REFERENCE_PROPERTY = 'dataYachiyoWorkspaceFileReference'

interface MarkdownAstNode {
  type?: string
  tagName?: string
  properties?: Record<string, unknown>
  children?: MarkdownAstNode[]
}

export function rewriteWorkspaceFileLinksForHarden(
  tree: MarkdownAstNode,
  resolvedReferences: ReadonlySet<string>
): void {
  if (tree.type === 'element' && tree.tagName === 'a') {
    const href = tree.properties?.href
    const reference =
      typeof href === 'string' ? matchResolvedReference(href, resolvedReferences) : null
    if (reference) {
      tree.tagName = 'span'
      tree.properties = { [WORKSPACE_FILE_REFERENCE_PROPERTY]: reference }
    }
  }

  if (!Array.isArray(tree.children)) return
  for (const child of tree.children) {
    rewriteWorkspaceFileLinksForHarden(child, resolvedReferences)
  }
}

/**
 * Pick the reading of this destination that the resolver actually found.
 *
 * Shares its ordering with the extraction side: whichever candidate was sent
 * for resolution is the one matched here, so the two ends of the chain cannot
 * drift into different decoding rules.
 */
function matchResolvedReference(
  href: string,
  resolvedReferences: ReadonlySet<string>
): string | null {
  for (const candidate of toMarkdownDestinationCandidates(href)) {
    if (resolvedReferences.has(candidate)) return candidate
  }
  return null
}

export const rehypeWorkspaceFileLinkTransform: Plugin<[readonly string[]]> =
  function rehypeWorkspaceFileLinkTransform(references) {
    const resolvedReferences = new Set(references)
    return (tree): void => {
      rewriteWorkspaceFileLinksForHarden(tree as MarkdownAstNode, resolvedReferences)
    }
  }
