import type { SampleResult } from './osascript.ts'

export interface ActivityOcrCaptureAllowed {
  allow: true
  category: 'productive' | 'generic'
}

export interface ActivityOcrCaptureBlocked {
  allow: false
  reason: 'yachiyo' | 'private-app' | 'low-value-app'
}

export type ActivityOcrCaptureDecision = ActivityOcrCaptureAllowed | ActivityOcrCaptureBlocked

const PRODUCTIVE_BUNDLE_PATTERNS = [
  /\bzed\b/iu,
  /code/iu,
  /terminal/iu,
  /iterm/iu,
  /ghostty/iu,
  /browser/iu,
  /safari/iu,
  /chrome/iu,
  /firefox/iu,
  /zen/iu,
  /preview/iu,
  /pdf/iu,
  /obsidian/iu
]

const PRIVATE_BUNDLE_PATTERNS = [
  /1password/iu,
  /bitwarden/iu,
  /keychain/iu,
  /password/iu,
  /secrets/iu,
  /authenticator/iu
]

const LOW_VALUE_BUNDLE_IDS = new Set([
  'com.apple.dock',
  'com.apple.controlcenter',
  'com.apple.finder',
  'com.apple.notificationcenterui',
  'com.apple.systempreferences',
  'com.apple.systemsettings',
  'com.raycast.macos',
  'sh.ringo.yachiyo'
])

const LOW_VALUE_APP_PATTERNS = [/spotlight/iu, /launcher/iu, /notification center/iu]

function sampleText(sample: SampleResult): string {
  return [sample.appName, sample.bundleId, sample.windowTitle]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .join(' ')
}

export function shouldCaptureOcrForSample(sample: SampleResult): ActivityOcrCaptureDecision {
  const bundleId = sample.bundleId.toLocaleLowerCase()
  const text = sampleText(sample)

  if (bundleId === 'sh.ringo.yachiyo' || sample.appName.toLocaleLowerCase() === 'yachiyo') {
    return { allow: false, reason: 'yachiyo' }
  }

  if (PRIVATE_BUNDLE_PATTERNS.some((pattern) => pattern.test(text))) {
    return { allow: false, reason: 'private-app' }
  }

  if (
    LOW_VALUE_BUNDLE_IDS.has(bundleId) ||
    LOW_VALUE_APP_PATTERNS.some((pattern) => pattern.test(text))
  ) {
    return { allow: false, reason: 'low-value-app' }
  }

  if (PRODUCTIVE_BUNDLE_PATTERNS.some((pattern) => pattern.test(text))) {
    return { allow: true, category: 'productive' }
  }

  return { allow: true, category: 'generic' }
}
