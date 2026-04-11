import type React from 'react'
import { useMemo } from 'react'
import type { Components, LinkSafetyConfig, UrlTransform } from 'streamdown'
import { Streamdown } from 'streamdown'
import { MarkdownErrorBoundary } from './MarkdownErrorBoundary'
import { LinkSafetyModal } from './LinkSafetyModal'
import { LinkableCode } from './LinkableCode'
import { mermaid } from '@streamdown/mermaid'
import { code } from '@streamdown/code'
import { mathPlugin } from './mathPlugin'
import { transformImageSrc } from './imageUrl'
import {
  MarkdownImage,
  MarkdownImageProvider,
  type MarkdownImageContextValue
} from './MarkdownImage'

interface MessageMarkdownProps {
  content: string
  isStreaming?: boolean
  /**
   * When provided, markdown image syntax is rendered: remote URLs become a
   * placeholder-with-download-button, local files and `yachiyo-asset://`
   * URLs render inline. Omit this for contexts where embedded images are
   * not allowed (e.g. user bubbles, which have their own attachment rail).
   */
  imageContext?: MarkdownImageContextValue
}

export function MessageMarkdown({
  content,
  isStreaming = false,
  imageContext
}: MessageMarkdownProps): React.JSX.Element {
  const linkSafety = useMemo<LinkSafetyConfig>(
    () => ({
      enabled: true,
      renderModal: (props) => <LinkSafetyModal {...props} />
    }),
    []
  )

  const imagesEnabled = Boolean(imageContext)

  const components = useMemo<Components>(() => {
    const base: Components = { inlineCode: LinkableCode }
    if (imagesEnabled) {
      base.img = MarkdownImage
    }
    return base
  }, [imagesEnabled])

  const urlTransform = useMemo<UrlTransform | undefined>(() => {
    if (!imagesEnabled) return undefined
    return (url, key, node) => {
      // Only intercept image sources; leave link hrefs and other attributes
      // to Streamdown's default safety rules.
      const isImageSrc = key === 'src' && node.tagName === 'img'
      if (!isImageSrc) return url
      return transformImageSrc(url) ?? undefined
    }
  }, [imagesEnabled])

  const animated = useMemo(
    () =>
      isStreaming
        ? ({ sep: 'word', animation: 'blurIn', duration: 120, easing: 'ease-out' } as const)
        : false,
    [isStreaming]
  )
  const plugins = useMemo(() => ({ math: mathPlugin, mermaid, code }), [])

  return (
    <MarkdownErrorBoundary fallback={content}>
      <MarkdownImageProvider value={imageContext ?? null}>
        <div className="streamdown-content message-selectable">
          <Streamdown
            isAnimating={isStreaming}
            animated={animated}
            caret={isStreaming ? 'circle' : undefined}
            mode={isStreaming ? 'streaming' : 'static'}
            controls={true}
            plugins={plugins}
            linkSafety={linkSafety}
            components={components}
            urlTransform={urlTransform}
          >
            {content}
          </Streamdown>
        </div>
      </MarkdownImageProvider>
    </MarkdownErrorBoundary>
  )
}
