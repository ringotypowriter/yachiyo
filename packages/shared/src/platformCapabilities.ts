export interface PlatformCapabilities {
  activityTracking: boolean
  activityOcr: boolean
  dockBadge: boolean
  keepAwake: boolean
  launchAtLogin: boolean
  macAutomationSkills: boolean
  primaryModifier: 'meta' | 'control'
  recommendedSyncProvider: 'icloud' | 'onedrive' | 'custom'
  uiFontFamily: string
  titleBarOverlay: boolean
  trafficLights: boolean
}

const MACOS_CAPABILITIES: PlatformCapabilities = {
  activityTracking: true,
  activityOcr: true,
  dockBadge: true,
  keepAwake: true,
  launchAtLogin: true,
  macAutomationSkills: true,
  primaryModifier: 'meta',
  recommendedSyncProvider: 'icloud',
  uiFontFamily: "'Avenir Next', 'Helvetica Neue', 'Segoe UI', sans-serif",
  titleBarOverlay: false,
  trafficLights: true
}

const WINDOWS_CAPABILITIES: PlatformCapabilities = {
  activityTracking: false,
  activityOcr: false,
  dockBadge: false,
  keepAwake: false,
  launchAtLogin: false,
  macAutomationSkills: false,
  primaryModifier: 'control',
  recommendedSyncProvider: 'onedrive',
  uiFontFamily: "'Segoe UI Variable', 'Segoe UI', sans-serif",
  titleBarOverlay: true,
  trafficLights: false
}

const OTHER_CAPABILITIES: PlatformCapabilities = {
  activityTracking: false,
  activityOcr: false,
  dockBadge: false,
  keepAwake: false,
  launchAtLogin: false,
  macAutomationSkills: false,
  primaryModifier: 'control',
  recommendedSyncProvider: 'custom',
  uiFontFamily: 'system-ui, sans-serif',
  titleBarOverlay: false,
  trafficLights: false
}

export function resolvePlatformCapabilities(platform: NodeJS.Platform): PlatformCapabilities {
  if (platform === 'darwin') return { ...MACOS_CAPABILITIES }
  if (platform === 'win32') return { ...WINDOWS_CAPABILITIES }
  return { ...OTHER_CAPABILITIES }
}
