import type { ActivityTrackingConfig, SettingsConfig } from '../../../shared/yachiyo/protocol.ts'

export interface ActivityTrackingPermissionDeps {
  platform: NodeJS.Platform
  requestAccessibilityTrust: () => boolean
  probeFullActivityAccess: () => Promise<boolean>
}

function cloneActivityOcrConfig(
  config: ActivityTrackingConfig['ocr']
): ActivityTrackingConfig['ocr'] {
  return config
    ? {
        enabled: config.enabled === true,
        excludedApps: [...(config.excludedApps ?? [])]
      }
    : undefined
}

function deniedActivityTrackingConfig(
  inputConfig: SettingsConfig,
  currentConfig: SettingsConfig
): ActivityTrackingConfig {
  const previousMode = currentConfig.general?.activityTracking?.mode
  const ocr = cloneActivityOcrConfig(
    inputConfig.general?.activityTracking?.ocr ?? currentConfig.general?.activityTracking?.ocr
  )
  return {
    mode: previousMode === 'off' ? 'off' : 'simple',
    accessibilityDenied: true,
    ...(ocr ? { ocr } : {})
  }
}

function allowedFullActivityTrackingConfig(inputConfig: SettingsConfig): ActivityTrackingConfig {
  const ocr = cloneActivityOcrConfig(inputConfig.general?.activityTracking?.ocr)
  return {
    mode: 'full',
    ...(ocr ? { ocr } : {})
  }
}

export async function resolveActivityTrackingPermissionForSave(
  input: SettingsConfig,
  currentConfig: SettingsConfig,
  deps: ActivityTrackingPermissionDeps
): Promise<SettingsConfig> {
  if (input.general?.activityTracking?.mode !== 'full') {
    return input
  }

  if (deps.platform !== 'darwin') {
    return {
      ...input,
      general: {
        ...input.general,
        activityTracking: deniedActivityTrackingConfig(input, currentConfig)
      }
    }
  }

  const electronTrusted = deps.requestAccessibilityTrust()
  const fullSamplerAvailable = electronTrusted && (await deps.probeFullActivityAccess())

  return {
    ...input,
    general: {
      ...input.general,
      activityTracking: fullSamplerAvailable
        ? allowedFullActivityTrackingConfig(input)
        : deniedActivityTrackingConfig(input, currentConfig)
    }
  }
}
