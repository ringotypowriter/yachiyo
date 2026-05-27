import type { Plugin } from 'unified'
import {
  isDirectImagePathCandidate,
  transformImageSrc,
  type TransformImageSrcOptions
} from './imageUrl.ts'

interface MarkdownAstNode {
  type?: string
  tagName?: string
  properties?: Record<string, unknown>
  children?: MarkdownAstNode[]
}

export function rewriteImageSourcesForHarden(
  tree: MarkdownAstNode,
  options: TransformImageSrcOptions = {}
): void {
  if (tree.type === 'element' && tree.tagName === 'img') {
    const rawSrc = tree.properties?.src
    if (typeof rawSrc === 'string') {
      const nextSrc = transformImageSrc(rawSrc, options)
      if (nextSrc) {
        tree.properties = { ...tree.properties, src: nextSrc }
      } else if (isDirectImagePathCandidate(rawSrc)) {
        const properties = { ...tree.properties }
        delete properties.src
        tree.properties = properties
      }
    }
  }

  if (!Array.isArray(tree.children)) return
  for (const child of tree.children) {
    rewriteImageSourcesForHarden(child, options)
  }
}

export const rehypeImageSrcTransform: Plugin<[TransformImageSrcOptions?]> =
  function rehypeImageSrcTransform(options = {}) {
    return (tree): void => {
      rewriteImageSourcesForHarden(tree as MarkdownAstNode, options)
    }
  }
