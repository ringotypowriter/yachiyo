import assert from 'node:assert/strict'
import test from 'node:test'

import { shouldCaptureOcrForSample } from './ActivityOcrPolicy.ts'

test('shouldCaptureOcrForSample allows productive foreground contexts', () => {
  assert.deepEqual(
    shouldCaptureOcrForSample({
      appName: 'Zed',
      bundleId: 'dev.zed.Zed',
      windowTitle: 'ActivityTracker.ts'
    }),
    { allow: true, category: 'productive' }
  )
})

test('shouldCaptureOcrForSample blocks private and low-value apps', () => {
  assert.equal(
    shouldCaptureOcrForSample({ appName: '1Password', bundleId: 'com.1password.1password' }).allow,
    false
  )
  assert.equal(
    shouldCaptureOcrForSample({
      appName: 'System Settings',
      bundleId: 'com.apple.systempreferences'
    }).allow,
    false
  )
  assert.equal(
    shouldCaptureOcrForSample({ appName: 'Yachiyo', bundleId: 'sh.ringo.yachiyo' }).allow,
    false
  )
})
