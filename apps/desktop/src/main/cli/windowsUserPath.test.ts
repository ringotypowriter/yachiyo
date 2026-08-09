import assert from 'node:assert/strict'
import test from 'node:test'

import {
  addWindowsUserPathEntry,
  buildWindowsUserPathReadCommand,
  installWindowsUserPathEntry,
  parseWindowsUserPathReadResult,
  removeWindowsUserPathEntry
} from './windowsUserPath.ts'

const YACHIYO_BIN = 'C:\\Users\\Yuki\\.yachiyo\\bin'

test('adding the Yachiyo user PATH entry preserves order and existing text exactly', () => {
  const current = '%USERPROFILE%\\bin;C:\\Windows\\System32;D:\\Tools & SDKs\\bin'

  assert.equal(addWindowsUserPathEntry(current, YACHIYO_BIN), `${current};${YACHIYO_BIN}`)
})

test('adding the Windows user PATH entry is case-insensitive and idempotent', () => {
  const current = `C:\\Windows\\System32;c:\\users\\yuki\\.YACHIYO\\bin\\;D:\\Tools`

  assert.equal(addWindowsUserPathEntry(current, YACHIYO_BIN), current)
})

test('removing Yachiyo deletes only its matching PATH entry', () => {
  const current = `C:\\One;${YACHIYO_BIN};C:\\Two;C:\\Users\\Yuki\\.yachiyo\\bin-tools`

  assert.equal(
    removeWindowsUserPathEntry(current, 'c:\\users\\yuki\\.YACHIYO\\bin\\'),
    'C:\\One;C:\\Two;C:\\Users\\Yuki\\.yachiyo\\bin-tools'
  )
})

test('empty user PATH values can be installed and removed without empty segments', () => {
  assert.equal(addWindowsUserPathEntry('', YACHIYO_BIN), YACHIYO_BIN)
  assert.equal(removeWindowsUserPathEntry(YACHIYO_BIN, YACHIYO_BIN), '')
})

test('installing through the user-scoped store writes only when the entry is absent', () => {
  let current = 'C:\\Windows\\System32'
  const writes: string[] = []
  const store = {
    read: () => current,
    write(value: string) {
      writes.push(value)
      current = value
    }
  }

  assert.equal(installWindowsUserPathEntry(YACHIYO_BIN, store), true)
  assert.equal(installWindowsUserPathEntry(YACHIYO_BIN, store), false)
  assert.deepEqual(writes, [`C:\\Windows\\System32;${YACHIYO_BIN}`])
})

test('reading the user PATH removes only PowerShell output framing', () => {
  assert.equal(
    parseWindowsUserPathReadResult({
      status: 0,
      stdout: 'C:\\Windows\\System32;C:\\Users\\山田\\Tools & SDKs\\bin\r\n',
      stderr: ''
    }),
    'C:\\Windows\\System32;C:\\Users\\山田\\Tools & SDKs\\bin'
  )
  assert.equal(parseWindowsUserPathReadResult({ status: 0, stdout: '\r\n', stderr: '' }), '')
})

test('PowerShell emits the user PATH as explicit UTF-8 before Node decodes it', () => {
  const command = buildWindowsUserPathReadCommand()

  assert.match(command, /Console\]::OutputEncoding/u)
  assert.match(command, /UTF8Encoding/u)
  assert.match(command, /GetEnvironmentVariable\('Path', 'User'\)/u)
})

test('a failed user PATH query aborts setup instead of treating the PATH as empty', () => {
  assert.throws(
    () =>
      parseWindowsUserPathReadResult({
        status: 1,
        stdout: '',
        stderr: 'Access is denied.'
      }),
    /Could not read the Windows user PATH: Access is denied\./u
  )
})
