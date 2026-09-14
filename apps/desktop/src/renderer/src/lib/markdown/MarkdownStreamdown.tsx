import type React from 'react'
import { memo, useMemo } from 'react'
import {
  Streamdown,
  type Components,
  type LinkSafetyConfig,
  type MermaidOptions,
  type PluginConfig,
  type UrlTransform
} from 'streamdown'
import type { PluggableList } from 'unified'
import type { ThemeVariant } from '../../theme/theme'
import { getMessageMarkdownAnimation } from './messageMarkdownAnimation'

interface MarkdownStreamdownProps {
  content: string
  isStreaming: boolean
  linkSafety: LinkSafetyConfig
  components: Components
  plugins: PluginConfig
  mermaidOptions: MermaidOptions
  mermaidThemeKey: ThemeVariant
  rehypePlugins: PluggableList
  urlTransform?: UrlTransform
  controls?: boolean
}

export const MarkdownStreamdown = memo(function MarkdownStreamdown({
  content,
  isStreaming,
  linkSafety,
  components,
  plugins,
  mermaidOptions,
  mermaidThemeKey,
  rehypePlugins,
  urlTransform,
  controls = true
}: MarkdownStreamdownProps): React.JSX.Element {
  const animated = useMemo(() => getMessageMarkdownAnimation(isStreaming), [isStreaming])
  // Streamdown caches parsed static content. Remount when a lazy syntax plugin
  // arrives so the already-rendered source is parsed with that plugin.
  const syntaxPluginKey = `${Boolean(plugins.code)}:${Boolean(plugins.math)}:${Boolean(
    plugins.mermaid
  )}`

  return (
    <Streamdown
      key={`${mermaidThemeKey}:${syntaxPluginKey}`}
      isAnimating={isStreaming}
      animated={animated}
      caret={isStreaming ? 'circle' : undefined}
      mode={isStreaming ? 'streaming' : 'static'}
      controls={controls}
      plugins={plugins}
      mermaid={mermaidOptions}
      rehypePlugins={rehypePlugins}
      linkSafety={linkSafety}
      components={components}
      urlTransform={urlTransform}
    >
      {content}
    </Streamdown>
  )
})
