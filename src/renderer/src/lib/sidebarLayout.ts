import {
  DEFAULT_SIDEBAR_VISIBILITY,
  normalizeSidebarVisibility,
  type SettingsConfig,
  type SidebarVisibility
} from '../../../shared/yachiyo/protocol.ts'

export const SIDEBAR_WIDTH = 260
export const TRAFFIC_LIGHTS_SAFE_ZONE = 80
export const MAIN_HEADER_HORIZONTAL_PADDING = 20
export const SIDEBAR_VISIBILITY_STORAGE_KEY = 'yachiyo.sidebarVisibility'

export interface SidebarLayout {
  dividerOffset: number | null
  mainHeaderPaddingLeft: number
  showDivider: boolean
  sidebarWidth: number
  toggleTitle: string
}

export function resolveSidebarLayout(isSidebarOpen: boolean): SidebarLayout {
  if (isSidebarOpen) {
    return {
      dividerOffset: SIDEBAR_WIDTH,
      mainHeaderPaddingLeft: MAIN_HEADER_HORIZONTAL_PADDING,
      showDivider: true,
      sidebarWidth: SIDEBAR_WIDTH,
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
