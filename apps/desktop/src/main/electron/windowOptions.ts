import type { BrowserWindowConstructorOptions } from 'electron'
import { resolvePlatformCapabilities } from '@yachiyo/shared/platformCapabilities'

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
      titleBarOverlay: {
        color: '#00000000',
        symbolColor: '#d7d7dc',
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
