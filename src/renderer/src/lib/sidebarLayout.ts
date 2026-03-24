import {
  DEFAULT_SIDEBAR_VISIBILITY,
  normalizeSidebarVisibility,
  type SettingsConfig,
  type SidebarVisibility
} from '../../../shared/yachiyo/protocol.ts'

export const SIDEBAR_WIDTH = 260
export const DEFAULT_SIDEBAR_WIDTH = 260
export const MIN_SIDEBAR_WIDTH = 180
export const MAX_SIDEBAR_WIDTH = 480
export const TRAFFIC_LIGHTS_SAFE_ZONE = 80
export const MAIN_HEADER_HORIZONTAL_PADDING = 20
export const SIDEBAR_VISIBILITY_STORAGE_KEY = 'yachiyo.sidebarVisibility'
export const SIDEBAR_WIDTH_STORAGE_KEY = 'yachiyo.sidebarWidth'

export interface SidebarLayout {
  dividerOffset: number | null
  mainHeaderPaddingLeft: number
  showDivider: boolean
  sidebarWidth: number
  toggleTitle: string
}

export function resolveSidebarLayout(
  isSidebarOpen: boolean,
  sidebarWidth: number = DEFAULT_SIDEBAR_WIDTH
): SidebarLayout {
  if (isSidebarOpen) {
    return {
      dividerOffset: sidebarWidth,
      mainHeaderPaddingLeft: MAIN_HEADER_HORIZONTAL_PADDING,
      showDivider: true,
      sidebarWidth,
      toggleTitle: 'Hide sidebar'
    }
  }

  return {
    dividerOffset: null,
    mainHeaderPaddingLeft: TRAFFIC_LIGHTS_SAFE_ZONE,
    showDivider: false,
    sidebarWidth: 0,
    toggleTitle: 'Show sidebar'
  }
}

export function parseStoredSidebarWidth(value: string | null | undefined): number | null {
  if (!value) return null
  const n = parseInt(value, 10)
  if (isNaN(n)) return null
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, n))
}

export function resolveSidebarVisibilityPreference(
  config: Pick<SettingsConfig, 'general'> | null | undefined,
  fallbackVisibility: SidebarVisibility = DEFAULT_SIDEBAR_VISIBILITY
): SidebarVisibility {
  return normalizeSidebarVisibility(config?.general?.sidebarVisibility, fallbackVisibility)
}

export function isSidebarOpenByPreference(
  config: Pick<SettingsConfig, 'general'> | null | undefined,
  fallbackVisibility: SidebarVisibility = DEFAULT_SIDEBAR_VISIBILITY
): boolean {
  return resolveSidebarVisibilityPreference(config, fallbackVisibility) === 'expanded'
}

export function applySidebarVisibilityPreference(
  config: SettingsConfig,
  sidebarVisibility: SidebarVisibility
): SettingsConfig {
  return {
    ...config,
    general: {
      ...config.general,
      sidebarVisibility
    }
  }
}

export function parseStoredSidebarVisibility(
  value: string | null | undefined
): SidebarVisibility | null {
  if (value !== 'expanded' && value !== 'collapsed') {
    return null
  }

  return value
}
