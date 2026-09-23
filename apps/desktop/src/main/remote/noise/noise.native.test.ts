import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { buildMailboxFixture, buildNoiseSessionFixtures } from './crossLanguageFixtures.ts'

// Runs under Electron's Node (BoringSSL) via `test:server:native`, where some OpenSSL ciphers
// that plain Node offers are missing. Rebuilding the byte-exact fixtures the iOS client also
// verifies proves the handshake, transport and mailbox crypto work in the shipped runtime.
const fixturesUrl = new URL(
  '../../../../../../packages/shared/src/remote/fixtures/',
  import.meta.url
)

function readFixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(name, fixturesUrl), 'utf8'))
}

test('noise sessions and mailbox boxes match the cross-language fixtures in this runtime', () => {
  assert.deepEqual(buildNoiseSessionFixtures(), readFixture('noise-sessions.json'))
  assert.deepEqual(buildMailboxFixture(), readFixture('mailbox.json'))
})
