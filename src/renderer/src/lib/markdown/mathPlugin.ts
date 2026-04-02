import type { MathPlugin } from 'streamdown'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'

export const mathPlugin: MathPlugin = {
  name: 'katex',
  type: 'math',
  remarkPlugin: remarkMath,
  rehypePlugin: rehypeKatex
}
