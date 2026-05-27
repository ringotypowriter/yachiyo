import assert from 'node:assert/strict'
import test from 'node:test'

import { shouldCaptureOcrForSample } from './ActivityOcrPolicy.ts'

test('shouldCaptureOcrForSample allows productive foreground contexts', () => {
  assert.deepEqual(
    shouldCaptureOcrForSample({
      appName: 'Example Code Editor',
      bundleId: 'com.example.code-editor',
      windowTitle: 'example-file.ts'
    }),
    { allow: true, category: 'productive' }
  )
})

test('shouldCaptureOcrForSample respects user excluded apps by app name or bundle id', () => {
  assert.equal(
    shouldCaptureOcrForSample(
      { appName: 'Example Chat', bundleId: 'com.example.chat', windowTitle: 'Example Chat' },
      ['Example Chat']
    ).allow,
    false
  )
  assert.equal(
    shouldCaptureOcrForSample(
      { appName: 'Example Browser', bundleId: 'com.example.browser', windowTitle: 'private tab' },
      ['com.example.browser']
    ).allow,
    false
  )
})

test('shouldCaptureOcrForSample blocks private and low-value apps', () => {
  assert.equal(
    shouldCaptureOcrForSample({
      appName: 'Example Password Manager',
      bundleId: 'com.example.password-manager'
    }).allow,
    false
  )
  assert.equal(
    shouldCaptureOcrForSample({
      appName: 'Example Settings',
      bundleId: 'com.apple.systempreferences'
    }).allow,
    false
  )
  assert.equal(
    shouldCaptureOcrForSample({ appName: 'Yachiyo', bundleId: 'sh.ringo.yachiyo' }).allow,
    false
  )
})
