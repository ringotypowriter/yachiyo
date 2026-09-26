import { APP_TOP_BAR_HEIGHT } from './appTabs.ts'

export interface TitleBarOverlayAppearance {
  symbolColor: string
  height: number
}

// `inkRgb` is a theme token value ("45 45 43"); `uiZoom` is the CSS zoom on #root.
export function resolveTitleBarOverlayAppearance(
  inkRgb: string,
  uiZoom: number
): TitleBarOverlayAppearance | null {
  const channels = inkRgb.trim().split(/\s+/).map(Number)
  if (channels.length !== 3 || channels.some((c) => !Number.isInteger(c) || c < 0 || c > 255)) {
    return null
  }
  const zoom = Number.isFinite(uiZoom) && uiZoom > 0 ? uiZoom : 1
  return {
    symbolColor: `#${channels.map((c) => c.toString(16).padStart(2, '0')).join('')}`,
    // The native caption band must match the zoomed top bar, not the unzoomed one.
    height: Math.round(APP_TOP_BAR_HEIGHT * zoom)
  }
}

// Native caption buttons are painted by the OS and cannot read CSS, so mirror the
// active theme ink and #root zoom into them whenever the root theme vars change.
export function syncTitleBarOverlay(
  apply: (appearance: TitleBarOverlayAppearance) => void
): () => void {
  const root = document.documentElement
  let lastKey = ''
  const sync = (): void => {
    const style = getComputedStyle(root)
    const appearance = resolveTitleBarOverlayAppearance(
      style.getPropertyValue('--yachiyo-rgb-ink'),
      Number.parseFloat(style.getPropertyValue('--yachiyo-ui-zoom'))
    )
    if (!appearance) return
    const key = `${appearance.symbolColor}:${appearance.height}`
    if (key === lastKey) return
    lastKey = key
    apply(appearance)
  }
  sync()
  const observer = new MutationObserver(sync)
  observer.observe(root, {
    attributes: true,
    attributeFilter: ['style', 'class', 'data-yachiyo-theme']
  })
  return () => observer.disconnect()
}
