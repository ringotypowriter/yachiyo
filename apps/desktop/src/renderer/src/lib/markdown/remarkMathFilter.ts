/**
 * Remark plugin that runs **after** remark-math and reverts `inlineMath` nodes
 * that are false-positive currency/price expressions.
 *
 * Uses negative logic: only revert what we can confidently identify as a price.
 * A node is a price when its content starts with a digit AND contains none of
 * the characters that signal real LaTeX (`\`, `^`, `_`, `{`, `}`, `=`).
 *
 * Examples reverted:  $4, $10/月, $3.99, $100k, $5M
 * Examples kept:      $x^2$, $2^{10}$, $E=mc^2$, $\alpha$, $n$
 */
import type { Root, PhrasingContent } from 'mdast'
import { visit } from 'unist-util-visit'

const RE_STARTS_WITH_DIGIT = /^\d/
const RE_LATEX_SYNTAX = /[\\^_{}=]/

function looksLikePrice(value: string): boolean {
  const text = value.trim()
  return RE_STARTS_WITH_DIGIT.test(text) && !RE_LATEX_SYNTAX.test(text)
}

export default function remarkMathFilter() {
  return (tree: Root) => {
    visit(tree, 'inlineMath', (node, index, parent) => {
      if (index == null || !parent) return
      if (!looksLikePrice(node.value)) return

      const replacement: PhrasingContent = {
        type: 'text',
        value: `$${node.value}$`
      }
      parent.children.splice(index, 1, replacement)
    })
  }
}
