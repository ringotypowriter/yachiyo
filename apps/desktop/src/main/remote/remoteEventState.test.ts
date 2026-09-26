import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { RemoteEventHubState } from './remoteEventHub.ts'
import { createRemoteEventStateFile } from './remoteEventState.ts'

const STATE: RemoteEventHubState = {
  epoch: 'epoch-1',
  seq: 42,
  journalFloor: 3,
  threads: [
    ['t1', { presence: { seq: 40, kind: 'summary' } }],
    [
      't2',
      {
        presence: { seq: 41, kind: 'removed', reason: 'archived' },
        run: {
          seq: 42,
          event: { type: 'run.status', threadId: 't2', runId: 'r1', status: 'completed' }
        }
      }
    ]
  ],
  appearance: { seq: 7, appearance: { themeId: 'mizu', themeAppearance: 'dark' } }
}

async function withPath(fn: (path: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'yachiyo-event-state-'))
  try {
    await fn(join(directory, 'remote', 'event-state.json'))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test('state closed cleanly is restored once; a crash after opening discards it', async () => {
  await withPath(async (path) => {
    assert.equal(createRemoteEventStateFile(path).open(), null, 'missing file')
    createRemoteEventStateFile(path).close(STATE)
    assert.deepEqual(createRemoteEventStateFile(path).open(), STATE)
    // Opening marked the file in use; without a close, the next start must not trust it.
    assert.equal(createRemoteEventStateFile(path).open(), null)
    assert.equal(JSON.parse(await readFile(path, 'utf8')).cleanShutdown, false)
  })
})

test('corrupt or malformed state starts a new epoch', async () => {
  await withPath(async (path) => {
    createRemoteEventStateFile(path).close(STATE)
    await writeFile(path, '{"version":1,"cleanShutdown":true,"state":{"epoch":""}}')
    assert.equal(createRemoteEventStateFile(path).open(), null)
    await writeFile(path, 'not json')
    const logs: string[] = []
    assert.equal(createRemoteEventStateFile(path, (line) => logs.push(line)).open(), null)
    assert.ok(logs.some((line) => line.includes('unreadable')))
  })
})
