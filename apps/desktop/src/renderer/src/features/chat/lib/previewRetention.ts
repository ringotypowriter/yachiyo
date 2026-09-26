export const PREVIEW_BACKGROUND_LIMIT = 3
export const PREVIEW_IDLE_MS = 5 * 60 * 1000

export interface PreviewReadingState {
  scrollTop?: number
  scrollLeft?: number
  pdfPage?: number
  zoom?: number
  imageX?: number
  imageY?: number
  rotation?: number
  diffPath?: string
  webScrollX?: number
  webScrollY?: number
  webZoom?: number
}

interface RetainedPreview {
  key: string
  hot: boolean
  lastUsedAt: number
}

export function previewDiscardCandidates<T extends RetainedPreview>(
  tabs: T[],
  current: string | null,
  now: number,
  protectedKeys: ReadonlySet<string> = new Set()
): T[] {
  const background = tabs
    .filter((tab) => tab.hot && tab.key !== current)
    .sort((a, b) => a.lastUsedAt - b.lastUsedAt)
  let remaining = background.length
  return background.filter((tab) => {
    if (protectedKeys.has(tab.key)) return false
    if (remaining <= PREVIEW_BACKGROUND_LIMIT && now - tab.lastUsedAt < PREVIEW_IDLE_MS)
      return false
    remaining--
    return true
  })
}
