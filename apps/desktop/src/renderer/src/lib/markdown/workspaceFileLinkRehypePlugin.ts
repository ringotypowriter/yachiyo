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
    if (typeof href === 'string' && resolvedReferences.has(href)) {
      tree.tagName = 'span'
      tree.properties = { [WORKSPACE_FILE_REFERENCE_PROPERTY]: href }
    }
  }

  if (!Array.isArray(tree.children)) return
  for (const child of tree.children) {
    rewriteWorkspaceFileLinksForHarden(child, resolvedReferences)
  }
}

export const rehypeWorkspaceFileLinkTransform: Plugin<[readonly string[]]> =
  function rehypeWorkspaceFileLinkTransform(references) {
    const resolvedReferences = new Set(references)
    return (tree): void => {
      rewriteWorkspaceFileLinksForHarden(tree as MarkdownAstNode, resolvedReferences)
    }
  }
