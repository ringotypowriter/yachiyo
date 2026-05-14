import type React from 'react'
import { memo, useCallback, useMemo } from 'react'
import type { Components, LinkSafetyConfig, PluginConfig, UrlTransform } from 'streamdown'
import { Streamdown } from 'streamdown'
import type { PluggableList } from 'unified'
import { MarkdownErrorBoundary } from './MarkdownErrorBoundary'
import { LinkSafetyModal } from './LinkSafetyModal'
import { LinkableCode } from './LinkableCode'
import { mermaid } from '@streamdown/mermaid'
import { code } from '@streamdown/code'
import { mathPlugin } from './mathPlugin'
import { transformImageSrc } from './imageUrl'
import { createMarkdownRehypePlugins } from './markdownRehypePlugins'
import {
  findMermaidPngExportSvg,
  renderMermaidSvgToPngBytes,
  serializeMermaidSvgForPng
} from './mermaidExportCapture'
import {
  MarkdownImage,
  MarkdownImageProvider,
  type MarkdownImageContextValue
} from './MarkdownImage'
import { getMessageMarkdownAnimation } from './messageMarkdownAnimation'
import type { InlineCodeFileLinkSnapshot } from './inlineCodeFileLinkSnapshot'
import { splitStreamingMarkdownSegments } from './streamingMarkdownSegments'

function waitForNextPaint(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve())
    })
  })
}

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
  inlineCodeFileLinks?: InlineCodeFileLinkSnapshot
}

interface MarkdownStreamdownProps {
  content: string
  isStreaming: boolean
  linkSafety: LinkSafetyConfig
  components: Components
  plugins: PluginConfig
  rehypePlugins: PluggableList
  urlTransform?: UrlTransform
}

const MarkdownStreamdown = memo(function MarkdownStreamdown({
  content,
  isStreaming,
  linkSafety,
  components,
  plugins,
  rehypePlugins,
  urlTransform
}: MarkdownStreamdownProps): React.JSX.Element {
  const animated = useMemo(() => getMessageMarkdownAnimation(isStreaming), [isStreaming])

  return (
    <Streamdown
      isAnimating={isStreaming}
      animated={animated}
      caret={isStreaming ? 'circle' : undefined}
      mode={isStreaming ? 'streaming' : 'static'}
      controls={true}
      plugins={plugins}
      rehypePlugins={rehypePlugins}
      linkSafety={linkSafety}
      components={components}
      urlTransform={urlTransform}
    >
      {content}
    </Streamdown>
  )
})

export function MessageMarkdown({
  content,
  isStreaming = false,
  imageContext,
  inlineCodeFileLinks
}: MessageMarkdownProps): React.JSX.Element {
  const linkSafety = useMemo<LinkSafetyConfig>(
    () => ({
      enabled: true,
      renderModal: (props) => <LinkSafetyModal {...props} />
    }),
    []
  )

  const imagesEnabled = Boolean(imageContext)
  const imageAssetVersion =
    imagesEnabled && isStreaming ? `stream:${Math.floor(content.length / 120)}` : undefined
  const imageTransformOptions = useMemo(
    () =>
      imageContext
        ? { basePath: imageContext.workspacePath, assetVersion: imageAssetVersion }
        : null,
    [imageAssetVersion, imageContext]
  )
  const inlineCodeFileLinksKey = useMemo(() => {
    if (!inlineCodeFileLinks || inlineCodeFileLinks.size === 0) return ''
    return JSON.stringify([...inlineCodeFileLinks.entries()])
  }, [inlineCodeFileLinks])

  const components = useMemo<Components>(() => {
    const base: Components = {
      inlineCode: (props) => <LinkableCode {...props} fileLinks={inlineCodeFileLinks} />
    }
    if (imagesEnabled) {
      base.img = MarkdownImage
    }
    return base
  }, [imagesEnabled, inlineCodeFileLinks])

  const rehypePlugins = useMemo(
    () => createMarkdownRehypePlugins(imageTransformOptions),
    [imageTransformOptions]
  )

  const urlTransform = useMemo<UrlTransform | undefined>(() => {
    if (!imagesEnabled) return undefined
    return (url, key, node) => {
      // Only intercept image sources; leave link hrefs and other attributes
      // to Streamdown's default safety rules.
      const isImageSrc = key === 'src' && node.tagName === 'img'
      if (!isImageSrc) return url
      return transformImageSrc(url, imageTransformOptions ?? undefined) ?? undefined
    }
  }, [imageTransformOptions, imagesEnabled])

  const plugins = useMemo<PluginConfig>(() => ({ math: mathPlugin, mermaid, code }), [])
  const handleClickCapture = useCallback((event: React.MouseEvent<HTMLDivElement>): void => {
    const svg = findMermaidPngExportSvg(event.target)
    if (!svg) return

    event.preventDefault()
    event.stopPropagation()
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))

    void waitForNextPaint()
      .then(async () => {
        const pngData = await renderMermaidSvgToPngBytes(serializeMermaidSvgForPng(svg))
        return window.api.yachiyo.savePngFile({ defaultFilename: 'diagram.png', pngData })
      })
      .catch((error) => {
        console.error('[mermaid] PNG export failed', error)
      })
  }, [])
  const streamingSegments = useMemo(
    () => (isStreaming ? splitStreamingMarkdownSegments(content) : null),
    [content, isStreaming]
  )
  const shouldRenderSegments =
    streamingSegments !== null && streamingSegments.stableSegments.length > 0

  return (
    <MarkdownErrorBoundary fallback={content}>
      <MarkdownImageProvider value={imageContext ?? null}>
        <div className="streamdown-content message-selectable" onClickCapture={handleClickCapture}>
          {shouldRenderSegments ? (
            <div className="streamdown-content__segments">
              {streamingSegments.stableSegments.map((segment, index) => (
                <div
                  className="streamdown-content__segment"
                  key={`${inlineCodeFileLinksKey}:stable:${index}`}
                >
                  <MarkdownStreamdown
                    content={segment}
                    isStreaming={false}
                    linkSafety={linkSafety}
                    components={components}
                    plugins={plugins}
                    rehypePlugins={rehypePlugins}
                    urlTransform={urlTransform}
                  />
                </div>
              ))}
              <div
                className="streamdown-content__segment"
                key={`${inlineCodeFileLinksKey}:active:${streamingSegments.stableSegments.length}`}
              >
                <MarkdownStreamdown
                  content={streamingSegments.activeSegment}
                  isStreaming={true}
                  linkSafety={linkSafety}
                  components={components}
                  plugins={plugins}
                  rehypePlugins={rehypePlugins}
                  urlTransform={urlTransform}
                />
              </div>
            </div>
          ) : (
            <MarkdownStreamdown
              key={inlineCodeFileLinksKey}
              content={content}
              isStreaming={isStreaming}
              linkSafety={linkSafety}
              components={components}
              plugins={plugins}
              rehypePlugins={rehypePlugins}
              urlTransform={urlTransform}
            />
          )}
        </div>
      </MarkdownImageProvider>
    </MarkdownErrorBoundary>
  )
}
