import { useEffect, useRef, useState } from 'react'
import { AlertCircle, ChevronLeft, ChevronRight, LoaderCircle, ZoomIn, ZoomOut } from 'lucide-react'
// Electron 39 lacks Map.getOrInsertComputed; both realms need PDF.js's bundled polyfills.
import {
  getDocument,
  GlobalWorkerOptions,
  type PDFDocumentProxy
} from 'pdfjs-dist/legacy/build/pdf.mjs'
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'
import { decodePdf, pdfPageNumber, pdfZoom, renderPdfPage } from '../lib/pdfPreview'
import type { PreviewReadingState } from '../lib/previewRetention'

GlobalWorkerOptions.workerSrc = workerUrl

export function PdfDocument({
  content,
  title,
  reading,
  onReadingChange
}: {
  content: string
  title: string
  reading?: PreviewReadingState
  onReadingChange?: (reading: PreviewReadingState) => void
}): React.JSX.Element {
  return (
    <PdfViewer
      key={content}
      content={content}
      title={title}
      reading={reading}
      onReadingChange={onReadingChange}
    />
  )
}

function PdfViewer({
  content,
  title,
  reading,
  onReadingChange
}: {
  content: string
  title: string
  reading?: PreviewReadingState
  onReadingChange?: (reading: PreviewReadingState) => void
}): React.JSX.Element {
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null)
  const [page, setPage] = useState(reading?.pdfPage ?? 1)
  const [zoom, setZoom] = useState(reading?.zoom ?? 1)
  const restoreScroll = useRef(reading)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const surface = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    let task: ReturnType<typeof getDocument> | undefined
    void (async () => {
      try {
        const assets = new URL('./pdfjs/', window.document.baseURI)
        task = getDocument({
          data: decodePdf(content),
          cMapUrl: new URL('cmaps/', assets).href,
          cMapPacked: true,
          standardFontDataUrl: new URL('standard_fonts/', assets).href,
          wasmUrl: new URL('wasm/', assets).href,
          // Use DOM asset factories: they fall back to XHR for packaged file:// URLs.
          useWorkerFetch: false
        })
        const pdf = await task.promise
        if (!cancelled) {
          setPage((page) => pdfPageNumber(page, pdf.numPages))
          setDocument(pdf)
        }
      } catch (reason) {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : 'Unable to load this PDF.')
          setLoading(false)
        }
      }
    })()
    return () => {
      cancelled = true
      // Destroy the loading task even if its document has not resolved yet.
      void task?.destroy().catch(() => {})
    }
  }, [content])

  useEffect(() => {
    if (!document || !surface.current) return
    const canvas = window.document.createElement('canvas')
    canvas.setAttribute('role', 'img')
    canvas.setAttribute('aria-label', `${title}, page ${page} of ${document.numPages}`)
    canvas.hidden = true
    surface.current.replaceChildren(canvas)
    surface.current.scrollTo(0, 0)
    const cancel = renderPdfPage({
      document,
      pageNumber: page,
      zoom,
      pixelRatio: window.devicePixelRatio || 1,
      canvas,
      onReady: () => {
        canvas.hidden = false
        if (restoreScroll.current && surface.current) {
          surface.current.scrollTop = restoreScroll.current.scrollTop ?? 0
          surface.current.scrollLeft = restoreScroll.current.scrollLeft ?? 0
          restoreScroll.current = undefined
        }
        setLoading(false)
      },
      onError: (reason) => {
        setError(reason instanceof Error ? reason.message : 'Unable to render this page.')
        setLoading(false)
      }
    })
    return () => {
      cancel()
      canvas.remove()
      canvas.width = 0
      canvas.height = 0
    }
  }, [document, page, zoom, title])

  const navigate = (nextPage: number, nextZoom: number): void => {
    if (nextPage === page && nextZoom === zoom) return
    setLoading(true)
    setError(null)
    setPage(nextPage)
    setZoom(nextZoom)
    restoreScroll.current = undefined
    onReadingChange?.({ pdfPage: nextPage, zoom: nextZoom, scrollTop: 0, scrollLeft: 0 })
  }

  return (
    <section className="content-reader-pdf" aria-label={title}>
      <div className="content-reader-pdf-toolbar" role="group" aria-label="PDF controls">
        <button
          type="button"
          title="Previous page"
          aria-label="Previous page"
          disabled={!document || page <= 1}
          onClick={() => navigate(pdfPageNumber(page - 1, document!.numPages), zoom)}
        >
          <ChevronLeft size={16} />
        </button>
        <span aria-live="polite">{document ? `${page} / ${document.numPages}` : '— / —'}</span>
        <button
          type="button"
          title="Next page"
          aria-label="Next page"
          disabled={!document || page >= document.numPages}
          onClick={() => navigate(pdfPageNumber(page + 1, document!.numPages), zoom)}
        >
          <ChevronRight size={16} />
        </button>
        <button
          type="button"
          title="Zoom out"
          aria-label="Zoom out"
          disabled={!document || zoom <= 0.25}
          onClick={() => navigate(page, pdfZoom(zoom - 0.25))}
        >
          <ZoomOut size={16} />
        </button>
        <button
          type="button"
          title="Reset zoom"
          aria-label="Reset zoom"
          disabled={!document}
          onClick={() => navigate(page, 1)}
        >
          {Math.round(zoom * 100)}%
        </button>
        <button
          type="button"
          title="Zoom in"
          aria-label="Zoom in"
          disabled={!document || zoom >= 3}
          onClick={() => navigate(page, pdfZoom(zoom + 0.25))}
        >
          <ZoomIn size={16} />
        </button>
      </div>
      {loading ? (
        <div className="content-reader-notice content-reader-pdf-notice" role="status">
          <LoaderCircle size={16} className="animate-spin" /> Loading PDF…
        </div>
      ) : null}
      {error ? (
        <div className="content-reader-notice content-reader-pdf-notice" role="alert">
          <AlertCircle size={16} />
          <span>{error} Use Open externally to continue.</span>
        </div>
      ) : null}
      <div
        ref={surface}
        className="content-reader-pdf-surface"
        aria-busy={loading}
        onScroll={(event) =>
          onReadingChange?.({
            pdfPage: page,
            zoom,
            scrollTop: event.currentTarget.scrollTop,
            scrollLeft: event.currentTarget.scrollLeft
          })
        }
      />
    </section>
  )
}
