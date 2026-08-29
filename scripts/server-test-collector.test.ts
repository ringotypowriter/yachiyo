import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { collectServerTestFiles } from './server-test-collector.mjs'

test('server test collector separates node and native baskets recursively', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-server-test-collector-'))
  const nested = join(root, 'nested')

  try {
    await mkdir(nested)
    await Promise.all([
      writeFile(join(root, 'ordinary.test.ts'), ''),
      writeFile(join(root, 'sqlite.native.test.ts'), ''),
      writeFile(join(nested, 'broker.native.test.ts'), ''),
      writeFile(join(nested, 'platform.mac.test.ts'), ''),
      writeFile(join(nested, 'not-a-test.ts'), '')
    ])

    assert.deepEqual(
      collectServerTestFiles(root, 'node')
        .map((file) => basename(file))
        .sort(),
      ['ordinary.test.ts']
    )
    assert.deepEqual(
      collectServerTestFiles(root, 'native')
        .map((file) => basename(file))
        .sort(),
      ['broker.native.test.ts', 'sqlite.native.test.ts']
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('native server test runner fails when its roots contain no native tests', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-empty-native-basket-'))

  try {
    await writeFile(join(root, 'ordinary.test.ts'), '')
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL('./run-server-tests.mjs', import.meta.url)), '--native', root],
      { encoding: 'utf8' }
    )

    assert.equal(result.status, 1)
    assert.match(result.stderr, /No native server tests found\./u)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
