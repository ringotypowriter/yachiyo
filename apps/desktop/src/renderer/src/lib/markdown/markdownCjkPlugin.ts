import type { PluginConfig } from 'streamdown'
import remarkCjkFriendly from 'remark-cjk-friendly'
import remarkCjkFriendlyGfmStrikethrough from 'remark-cjk-friendly-gfm-strikethrough'
import { remarkAutolinkTextBoundary } from './remarkAutolinkTextBoundary.ts'

type CjkPlugin = NonNullable<PluginConfig['cjk']>

/**
 * CommonMark's flanking rules reject emphasis whose closing marker sits
 * between full-width punctuation and a CJK letter (`**测试一步：**用`), so the
 * bold renders as literal `**`. remark-cjk-friendly relaxes those rules and
 * must run before remarkGfm; the strikethrough variant and our autolink
 * boundary splitter run after it.
 */
export const markdownCjkPlugin: CjkPlugin = {
  name: 'cjk',
  type: 'cjk',
  remarkPlugins: [],
  remarkPluginsBefore: [remarkCjkFriendly],
  remarkPluginsAfter: [remarkAutolinkTextBoundary, remarkCjkFriendlyGfmStrikethrough]
}
