import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from 'pdfjs-dist'

export function decodePdf(content: string): Uint8Array {
  return Uint8Array.from(atob(content), (character) => character.charCodeAt(0))
}

export function pdfPageNumber(page: number, count: number): number {
  return Math.max(1, Math.min(count, Math.round(page)))
}

export function pdfZoom(zoom: number): number {
  return Math.max(0.25, Math.min(3, Math.round(zoom * 100) / 100))
}

// Each render owns its canvas. A cancelled render can never paint over its successor.
export function renderPdfPage({
  document,
  pageNumber,
  zoom,
  pixelRatio,
  canvas,
  onReady,
  onError
}: {
  document: Pick<PDFDocumentProxy, 'getPage'>
  pageNumber: number
  zoom: number
  pixelRatio: number
  canvas: HTMLCanvasElement
  onReady: () => void
  onError: (error: unknown) => void
}): () => void {
  let cancelled = false
  let page: PDFPageProxy | undefined
  let render: RenderTask | undefined
  void (async () => {
    try {
      page = await document.getPage(pageNumber)
      if (cancelled) return
      const viewport = page.getViewport({ scale: zoom })
      // Bound backing-store memory for unusually large pages and high-DPI displays.
      const ratio = Math.min(
        pixelRatio,
        2,
        Math.sqrt(16_000_000 / (viewport.width * viewport.height))
      )
      canvas.width = Math.ceil(viewport.width * ratio)
      canvas.height = Math.ceil(viewport.height * ratio)
      canvas.style.width = `${viewport.width}px`
      canvas.style.height = `${viewport.height}px`
      render = page.render({
        canvas,
        viewport,
        transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0]
      })
      await render.promise
      if (!cancelled) onReady()
    } catch (error) {
      if (!cancelled) onError(error)
    } finally {
      page?.cleanup()
    }
  })()
  return () => {
    cancelled = true
    render?.cancel()
  }
}
