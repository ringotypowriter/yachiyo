import React, { createContext, useCallback, useContext, useState } from 'react'
import type { ImgHTMLAttributes } from 'react'
import { Download, ImageOff, Loader2 } from 'lucide-react'
import { theme } from '@renderer/theme/theme'
import { isAssetUrl, isRemoteImageUrl } from './imageUrl'
import { ImageDetailViewer } from './ImageDetailViewer'

/**
 * Context set up by `MessageMarkdown` when image rendering is enabled for
 * a bubble. Provides enough information to run the "download this remote
 * image into the workspace and rewrite the stored message content" flow.
 *
 * For read-only surfaces (archived threads, external thread viewer), omit
 * `downloadRemoteImage`: images still render, but remote placeholders are
 * shown without a Download button because we don't want to mutate stored
 * messages from a viewer-only context.
 */
export interface MarkdownImageContextValue {
  threadId: string
  messageId: string
  /**
   * Download `remoteUrl`, save it into the workspace attachments folder,
   * rewrite the stored message content so future renders point at the
   * local copy, and return the new `src` the renderer should use.
   * Throws on failure. Omit to render remote images in read-only mode.
   */
  downloadRemoteImage?: (remoteUrl: string) => Promise<string>
}

const MarkdownImageContext = createContext<MarkdownImageContextValue | null>(null)

export function MarkdownImageProvider({
  value,
  children
}: {
  value: MarkdownImageContextValue | null
  children: React.ReactNode
}): React.JSX.Element {
  return <MarkdownImageContext.Provider value={value}>{children}</MarkdownImageContext.Provider>
}

function useMarkdownImageContext(): MarkdownImageContextValue | null {
  return useContext(MarkdownImageContext)
}

const IMG_MAX_WIDTH = 520
const IMG_MAX_HEIGHT = 420

const imageStyle: React.CSSProperties = {
  maxWidth: '100%',
  maxHeight: IMG_MAX_HEIGHT,
  width: 'auto',
  height: 'auto',
  borderRadius: 10,
  display: 'block',
  border: `1px solid ${theme.border.subtle}`
}

const cardBaseStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 10,
  padding: '10px 12px',
  maxWidth: IMG_MAX_WIDTH,
  borderRadius: 10,
  border: `1px solid ${theme.border.default}`,
  background: theme.background.surfaceSoft,
  color: theme.text.secondary,
  fontSize: 13,
  lineHeight: 1.3
}

const buttonStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  padding: '4px 10px',
  borderRadius: 6,
  border: `1px solid ${theme.border.default}`,
  background: theme.background.surface,
  color: theme.text.primary,
  fontSize: 12,
  fontWeight: 500,
  cursor: 'pointer'
}

function prettyHost(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

function RemoteImageCard({
  src,
  alt,
  onResolved
}: {
  src: string
  alt?: string
  onResolved: (nextSrc: string) => void
}): React.JSX.Element {
  const ctx = useMarkdownImageContext()
  const downloader = ctx?.downloadRemoteImage ?? null
  const [state, setState] = useState<'idle' | 'loading' | 'error'>('idle')
  const [error, setError] = useState<string | null>(null)

  const handleDownload = useCallback(async () => {
    if (!downloader) return
    setState('loading')
    setError(null)
    try {
      const next = await downloader(src)
      onResolved(next)
    } catch (err) {
      console.error('[markdown-image] download failed', err)
      setState('error')
      setError(err instanceof Error ? err.message : 'Download failed')
    }
  }, [downloader, onResolved, src])

  const label = alt?.trim() || prettyHost(src)
  const statusText = (() => {
    if (state === 'error' && error) return error
    if (!downloader) return 'Remote image — read-only view'
    return 'Remote image — not downloaded'
  })()

  return (
    <span style={cardBaseStyle}>
      <ImageOff size={16} aria-hidden />
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
        <span style={{ color: theme.text.primary, fontWeight: 500 }}>{label}</span>
        <br />
        <span style={{ color: theme.text.tertiary, fontSize: 11 }}>{statusText}</span>
      </span>
      {downloader ? (
        <button
          type="button"
          style={buttonStyle}
          onClick={handleDownload}
          disabled={state === 'loading'}
          aria-label="Download image"
        >
          {state === 'loading' ? (
            <Loader2 size={13} className="animate-spin" />
          ) : (
            <Download size={13} />
          )}
          {state === 'loading' ? 'Downloading' : 'Download'}
        </button>
      ) : null}
    </span>
  )
}

function LocalImage({ src, alt }: { src: string; alt?: string }): React.JSX.Element {
  const [broken, setBroken] = useState(false)
  const [viewerOpen, setViewerOpen] = useState(false)

  const handleClick = useCallback((e: React.MouseEvent<HTMLImageElement>) => {
    // When the image is wrapped in a link ([![alt](...)](href)), let the
    // link action handle the click instead of opening the viewer.
    if ((e.target as HTMLElement).closest('a')) return
    e.stopPropagation()
    setViewerOpen(true)
  }, [])

  if (broken) {
    return (
      <span style={cardBaseStyle}>
        <ImageOff size={16} aria-hidden />
        <span>
          <span style={{ color: theme.text.primary, fontWeight: 500 }}>
            {alt?.trim() || 'Image unavailable'}
          </span>
          <br />
          <span style={{ color: theme.text.tertiary, fontSize: 11 }}>
            File not found or unreadable
          </span>
        </span>
      </span>
    )
  }

  return (
    <>
      <img
        src={src}
        alt={alt ?? ''}
        style={{ ...imageStyle, cursor: 'zoom-in' }}
        loading="lazy"
        draggable={false}
        onError={() => setBroken(true)}
        onClick={handleClick}
      />
      <ImageDetailViewer
        src={src}
        alt={alt}
        isOpen={viewerOpen}
        onClose={() => setViewerOpen(false)}
      />
    </>
  )
}

/**
 * Component wired into Streamdown as `components.img`. Delegates to the
 * remote-placeholder card for http(s) URLs and to a plain `<img>` for
 * `yachiyo-asset://` / `data:` sources.
 */
type MarkdownImageProps = ImgHTMLAttributes<HTMLImageElement>

export function MarkdownImage({ src, alt }: MarkdownImageProps): React.JSX.Element | null {
  const [resolvedSrc, setResolvedSrc] = useState<string | null>(null)

  if (typeof src !== 'string' || !src) return null

  const effectiveSrc = resolvedSrc ?? src

  if (isRemoteImageUrl(effectiveSrc)) {
    return <RemoteImageCard src={effectiveSrc} alt={alt ?? undefined} onResolved={setResolvedSrc} />
  }

  if (isAssetUrl(effectiveSrc) || effectiveSrc.startsWith('data:image/')) {
    return <LocalImage src={effectiveSrc} alt={alt ?? undefined} />
  }

  // Anything else should already have been filtered by urlTransform; render
  // nothing rather than leaking an unknown scheme to the DOM.
  return null
}
