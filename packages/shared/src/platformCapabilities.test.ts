import assert from 'node:assert/strict'
import test from 'node:test'

import { resolvePlatformCapabilities } from './platformCapabilities.ts'

test('macOS capabilities preserve the existing desktop behavior', () => {
  assert.deepEqual(resolvePlatformCapabilities('darwin'), {
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
  })
})

test('Windows capabilities expose only the supported Windows 11 surface', () => {
  assert.deepEqual(resolvePlatformCapabilities('win32'), {
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
  })
})
