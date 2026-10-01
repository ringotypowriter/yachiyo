import assert from 'node:assert/strict'
import test from 'node:test'

import { parseSettingsFieldResolutions } from './settingsFieldResolutionsCodec.ts'

const local = {
  path: 'chat.model',
  localFingerprint: 'local-hash',
  remoteFingerprint: 'remote-hash',
  choice: 'local'
}
const remote = { ...local, choice: 'remote' }

test('settings field memory ignores absent, malformed and non-array JSON', () => {
  for (const value of [undefined, '', '{broken', '{}', 'null', '1']) {
    assert.deepEqual(parseSettingsFieldResolutions(value), [])
  }
})

test('settings field memory retains valid choices and filters incomplete records', () => {
  const records = [
    local,
    null,
    1,
    {},
    { ...local, path: 1 },
    { ...local, localFingerprint: null },
    { ...local, remoteFingerprint: 3 },
    { ...local, choice: 'unknown' },
    remote
  ]
  assert.deepEqual(parseSettingsFieldResolutions(JSON.stringify(records)), [local, remote])
})
