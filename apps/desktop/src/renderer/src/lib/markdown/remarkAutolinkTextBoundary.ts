import type { Plugin } from 'unified'

import { splitAutolinkCandidate } from './autolinkTextBoundary.ts'

interface MarkdownPosition {
  start?: { offset?: number }
  end?: { offset?: number }
}

interface MarkdownNode {
  type: string
  value?: string
  url?: string
  children?: MarkdownNode[]
  position?: MarkdownPosition
}

interface VFileLike {
  value?: unknown
}

function getNodeSource(node: MarkdownNode, fileValue: unknown): string | null {
  const start = node.position?.start?.offset
  const end = node.position?.end?.offset
  if (typeof fileValue !== 'string' || typeof start !== 'number' || typeof end !== 'number') {
    return null
  }
  return fileValue.slice(start, end)
}

function isLiteralAutolink(node: MarkdownNode, fileValue: unknown): boolean {
  if (node.type !== 'link' || typeof node.url !== 'string') return false

  const child = node.children?.[0]
  if (node.children?.length !== 1 || child?.type !== 'text' || child.value !== node.url) {
    return false
  }

  return getNodeSource(node, fileValue) === node.url
}

function rewriteChildren(parent: MarkdownNode, fileValue: unknown): void {
  const children = parent.children
  if (!children) return

  for (let index = 0; index < children.length; index += 1) {
    const child = children[index]

    if (isLiteralAutolink(child, fileValue)) {
      const split = splitAutolinkCandidate(child.url!)
      if (!split) {
        children.splice(index, 1, { type: 'text', value: child.url })
        continue
      }
      if (split.trailingText) {
        children.splice(
          index,
          1,
          {
            ...child,
            url: split.url,
            children: [{ type: 'text', value: split.url }]
          },
          { type: 'text', value: split.trailingText }
        )
        index += 1
        continue
      }
    }

    rewriteChildren(child, fileValue)
  }
}

export const remarkAutolinkTextBoundary: Plugin = function remarkAutolinkTextBoundary() {
  return (tree, file) => {
    rewriteChildren(tree as MarkdownNode, (file as VFileLike).value)
  }
}
