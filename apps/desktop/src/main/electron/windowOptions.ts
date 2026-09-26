import type { BrowserWindowConstructorOptions, TitleBarOverlayOptions } from 'electron'
import { resolvePlatformCapabilities } from '@yachiyo/shared/platformCapabilities'

// Transparent keeps the renderer's chrome visible behind the caption buttons;
// Electron derives their hover fill from the native theme, not from this color.
const TITLE_BAR_OVERLAY_COLOR = '#00000000'
const TITLE_BAR_OVERLAY_HEIGHT_RANGE = { min: 24, max: 120 }

// Renderer-reported caption appearance; anything malformed is rejected, not coerced.
export function parseTitleBarOverlayUpdate(input: unknown): TitleBarOverlayOptions | null {
  if (typeof input !== 'object' || input === null) return null
  const { symbolColor, height } = input as Record<string, unknown>
  if (typeof symbolColor !== 'string' || !/^#[0-9a-f]{6}$/i.test(symbolColor)) return null
  if (
    typeof height !== 'number' ||
    !Number.isInteger(height) ||
    height < TITLE_BAR_OVERLAY_HEIGHT_RANGE.min ||
    height > TITLE_BAR_OVERLAY_HEIGHT_RANGE.max
  ) {
    return null
  }
  return { color: TITLE_BAR_OVERLAY_COLOR, symbolColor, height }
}

export function buildMainWindowOptions(
  platform: NodeJS.Platform
): Partial<BrowserWindowConstructorOptions> {
  const capabilities = resolvePlatformCapabilities(platform)
  if (capabilities.trafficLights) {
    return {
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 14, y: 15 },
      vibrancy: 'under-window',
      visualEffectState: 'active',
      backgroundColor: '#00000000'
    }
  }
  if (capabilities.titleBarOverlay) {
    return {
      titleBarStyle: 'hidden',
      // Placeholder until the renderer reports the resolved theme on first paint.
      titleBarOverlay: {
        color: TITLE_BAR_OVERLAY_COLOR,
        symbolColor: '#8e8e93',
        height: 48
      }
    }
  }
  return {}
}

export function buildAuxiliaryWindowOptions(
  platform: NodeJS.Platform
): Partial<BrowserWindowConstructorOptions> {
  const capabilities = resolvePlatformCapabilities(platform)
  if (capabilities.trafficLights) {
    return {
      transparent: true,
      vibrancy: 'hud',
      visualEffectState: 'active',
      backgroundColor: '#00000000'
    }
  }
  if (capabilities.titleBarOverlay) {
    return {
      transparent: false,
      backgroundColor: '#17171a',
      closable: true,
      skipTaskbar: true
    }
  }
  return { transparent: false, backgroundColor: '#17171a' }
}
