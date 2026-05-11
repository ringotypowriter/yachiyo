export interface SerializedMermaidSvg {
  svgText: string
  width: number
  height: number
}

const SVG_XMLNS = 'http://www.w3.org/2000/svg'
const PNG_EXPORT_SCALE = 2

export function findMermaidPngExportSvg(eventTarget: EventTarget | null): Element | null {
  if (!(eventTarget instanceof Element)) return null

  const button = eventTarget.closest('button')
  if (!(button instanceof HTMLButtonElement)) return null
  if (button.textContent?.trim().toUpperCase() !== 'PNG') return null

  const actions = button.closest("[data-streamdown='mermaid-block-actions']")
  if (!actions) return null

  const block = button.closest("[data-streamdown='mermaid-block']")
  if (!(block instanceof HTMLElement)) return null

  const chart = block.querySelector("[aria-label='Mermaid chart']")
  const chartSvg = chart?.querySelector('svg')
  if (chartSvg instanceof Element) return chartSvg

  const renderedSvg = block.querySelector("[data-streamdown='mermaid'] svg")
  return renderedSvg instanceof Element ? renderedSvg : null
}

export function serializeMermaidSvgForPng(svg: Element): SerializedMermaidSvg {
  const { width, height } = getMermaidSvgDimensions(svg)
  const clone = svg.cloneNode(true)
  if (!(clone instanceof Element)) {
    throw new Error('Unable to clone Mermaid SVG for PNG export.')
  }

  clone.setAttribute('xmlns', SVG_XMLNS)
  clone.setAttribute('width', String(width))
  clone.setAttribute('height', String(height))
  if (!clone.getAttribute('viewBox')) {
    clone.setAttribute('viewBox', `0 0 ${width} ${height}`)
  }

  return {
    svgText: new XMLSerializer().serializeToString(clone),
    width,
    height
  }
}

export async function renderMermaidSvgToPngBytes(
  source: SerializedMermaidSvg,
  scale = PNG_EXPORT_SCALE
): Promise<ArrayBuffer> {
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new Error('PNG export scale must be a positive number.')
  }

  const image = await loadSvgImage(source.svgText)
  const canvas = document.createElement('canvas')
  canvas.width = Math.ceil(source.width * scale)
  canvas.height = Math.ceil(source.height * scale)

  const context = canvas.getContext('2d')
  if (!context) {
    throw new Error('Unable to create canvas context for PNG export.')
  }

  context.drawImage(image, 0, 0, canvas.width, canvas.height)
  const blob = await canvasToPngBlob(canvas)
  return blob.arrayBuffer()
}

function getMermaidSvgDimensions(svg: Element): { width: number; height: number } {
  const viewBoxDimensions = parseViewBoxDimensions(svg.getAttribute('viewBox'))
  if (viewBoxDimensions) return viewBoxDimensions

  const width = parseSvgLength(svg.getAttribute('width'))
  const height = parseSvgLength(svg.getAttribute('height'))
  if (width !== null && height !== null) return { width, height }

  const rect = svg.getBoundingClientRect()
  if (rect.width > 0 && rect.height > 0) {
    return { width: rect.width, height: rect.height }
  }

  throw new Error('Mermaid SVG has no exportable dimensions.')
}

function parseViewBoxDimensions(input: string | null): { width: number; height: number } | null {
  if (!input) return null

  const values = input
    .trim()
    .split(/[\s,]+/)
    .map((part) => Number(part))
  if (values.length !== 4) return null

  const width = values[2]
  const height = values[3]
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null
  }

  return { width, height }
}

function parseSvgLength(input: string | null): number | null {
  if (!input) return null

  const match = input.trim().match(/^(\d+(?:\.\d+)?)(?:px)?$/)
  if (!match) return null

  const value = Number(match[1])
  return Number.isFinite(value) && value > 0 ? value : null
}

function loadSvgImage(svgText: string): Promise<HTMLImageElement> {
  const blob = new Blob([svgText], { type: 'image/svg+xml;charset=utf-8' })
  const url = URL.createObjectURL(blob)

  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => {
      URL.revokeObjectURL(url)
      resolve(image)
    }
    image.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('Unable to load Mermaid SVG for PNG export.'))
    }
    image.src = url
  })
}

function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('Unable to encode Mermaid PNG export.'))
        return
      }

      resolve(blob)
    }, 'image/png')
  })
}
