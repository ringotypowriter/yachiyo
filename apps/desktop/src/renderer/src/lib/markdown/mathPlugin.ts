import type { MathPlugin } from 'streamdown'
import type { Pluggable } from 'unified'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import remarkMathFilter from './remarkMathFilter'

/**
 * Composed remark plugin: parse math syntax first, then revert
 * false-positive currency expressions like $4, $10/月.
 */
const remarkMathWithFilter: Pluggable = function (this: unknown) {
  // Attach remark-math's tokenizer extensions onto the processor
  remarkMath.call(this as never)
  // Return the AST transform that reverts price-like false positives
  return remarkMathFilter()
}

export const mathPlugin: MathPlugin = {
  name: 'katex',
  type: 'math',
  remarkPlugin: remarkMathWithFilter,
  rehypePlugin: rehypeKatex
}
