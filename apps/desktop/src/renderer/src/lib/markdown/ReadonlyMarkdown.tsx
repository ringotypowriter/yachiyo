import { useCallback, useEffect, useMemo, useState } from 'react'
import { ImageOff } from 'lucide-react'
import type { Components, MermaidOptions, PluginConfig, UrlTransform } from 'streamdown'
import { loadHeavyMarkdownPlugins, type HeavyMarkdownPlugins } from './heavyMarkdownPlugins'
import { markdownCjkPlugin } from './markdownCjkPlugin'
import { createMarkdownRehypePlugins } from './markdownRehypePlugins'
import { MarkdownErrorBoundary } from './MarkdownErrorBoundary'
import { MarkdownStreamdown } from './MarkdownStreamdown'
import { isRemoteImageUrl, transformImageSrc } from './imageUrl'
import { trackShareCodeReadiness } from './shareCodeReadiness'
import type { ResponseShareTheme } from '../../features/chat/lib/share/responseShareTheme'

function StaticImage({ src, alt }: { src?: string; alt?: string }): React.JSX.Element {
  const [failed, setFailed] = useState(false)
  const remote = Boolean(src && isRemoteImageUrl(src))
  if (!src || remote || failed) {
    return (
      <span className="response-share-image-placeholder">
        <ImageOff size={18} />
        <span>
          {alt || 'Image'} — {remote ? 'not downloaded' : 'unavailable'}
          {remote ? (
            <>
              <br />
              <a href={src} tabIndex={-1}>
                {src}
              </a>
            </>
          ) : null}
        </span>
      </span>
    )
  }
  return <img src={src} alt={alt ?? ''} loading="eager" onError={() => setFailed(true)} />
}

const components: Components = {
  img: ({ src, alt }) => (
    <StaticImage
      key={typeof src === 'string' ? src : ''}
      src={typeof src === 'string' ? src : undefined}
      alt={alt}
    />
  ),
  a: ({ href, children }) =>
    /^https?:\/\//i.test(href ?? '') ? (
      <a href={href} tabIndex={-1}>
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
  inlineCode: ({ children }) => <code>{children}</code>
}
const linkSafety = { enabled: false }

/** The shared Markdown engine without live-message actions or mutable image contexts. */
export function ReadonlyMarkdown({
  content,
  theme,
  workspacePath
}: {
  content: string
  theme: ResponseShareTheme
  workspacePath?: string
}): React.JSX.Element {
  const [codePending, setCodePending] = useState(false)
  const onCodePending = useCallback((pending: boolean): void => {
    queueMicrotask(() => setCodePending(pending))
  }, [])
  const rehypePlugins = useMemo(
    () => createMarkdownRehypePlugins({ basePath: workspacePath }),
    [workspacePath]
  )
  const urlTransform = useMemo<UrlTransform>(
    () => (url, key, node) =>
      key === 'src' && node.tagName === 'img'
        ? (transformImageSrc(url, { basePath: workspacePath }) ?? undefined)
        : /^https?:\/\//i.test(url)
          ? url
          : undefined,
    [workspacePath]
  )
  const [loaded, setLoaded] = useState<{ content: string; plugins: HeavyMarkdownPlugins } | null>(
    null
  )
  const [failure, setFailure] = useState<{ content: string; message: string } | null>(null)
  const error = failure?.content === content ? failure.message : null
  useEffect(() => {
    let active = true
    void loadHeavyMarkdownPlugins(content)
      .then((plugins) => {
        if (active) {
          setLoaded({ content, plugins })
          setFailure(null)
        }
      })
      .catch((reason: unknown) => {
        if (active)
          setFailure({
            content,
            message: reason instanceof Error ? reason.message : 'Rich formatting could not load.'
          })
      })
    return () => {
      active = false
    }
  }, [content])
  const plugins = useMemo<PluginConfig>(
    () => ({
      cjk: markdownCjkPlugin,
      ...loaded?.plugins,
      ...(loaded?.plugins.code
        ? {
            code: trackShareCodeReadiness(
              {
                ...loaded.plugins.code,
                getThemes: () => [theme.codeTheme, theme.codeTheme],
                highlight: (options, callback) =>
                  loaded.plugins.code!.highlight(
                    { ...options, themes: [theme.codeTheme, theme.codeTheme] },
                    callback
                  )
              },
              onCodePending
            )
          }
        : {})
    }),
    [loaded, onCodePending, theme]
  )
  const mermaidOptions = useMemo<MermaidOptions>(
    () => ({
      ...theme.mermaid,
      errorComponent: ({ chart }) => (
        <div data-share-error="Diagram could not be rendered.">
          <pre>{chart}</pre>
        </div>
      )
    }),
    [theme]
  )
  const ready = loaded?.content === content
  return (
    <div
      className="streamdown-content response-share-markdown"
      data-share-code-pending={codePending ? 'true' : undefined}
      data-share-error={error ?? undefined}
      data-share-pending={!ready && !error ? 'true' : undefined}
    >
      <MarkdownErrorBoundary fallback={content} exportMode>
        {ready ? (
          <MarkdownStreamdown
            content={content}
            isStreaming={false}
            controls={false}
            linkSafety={linkSafety}
            components={components}
            plugins={plugins}
            rehypePlugins={rehypePlugins}
            mermaidOptions={mermaidOptions}
            mermaidThemeKey={theme.variant}
            urlTransform={urlTransform}
          />
        ) : (
          <pre>{content}</pre>
        )}
      </MarkdownErrorBoundary>
    </div>
  )
}
