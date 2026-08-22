import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { RunSnapshot } from '@yachiyo/shared/fileSnapshot'
import { resolveYachiyoFileHistoryDir } from '../../config/paths.ts'
import { deleteSnapshotIndex, loadSnapshotIndex, saveSnapshotIndex } from './snapshotIndex.ts'

const originalHome = process.env['YACHIYO_HOME']

function createSnapshot(runId: string): RunSnapshot {
  return {
    runId,
    threadId: 'thread-1',
    workspacePath: '/workspace',
    createdAt: '2026-08-22T00:00:00.000Z',
    entries: []
  }
}

test('snapshotIndex uses Windows-portable filenames for composite and reserved run IDs', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'snapshot-index-test-'))
  process.env['YACHIYO_HOME'] = home

  t.after(async () => {
    if (originalHome === undefined) {
      delete process.env['YACHIYO_HOME']
    } else {
      process.env['YACHIYO_HOME'] = originalHome
    }
    await rm(home, { recursive: true, force: true })
  })

  const workspaceHash = 'workspace-1'
  const snapshot = createSnapshot('run-1:subagent:agent-1')
  await saveSnapshotIndex(workspaceHash, snapshot)

  const files = await readdir(join(resolveYachiyoFileHistoryDir(), workspaceHash, 'snapshots'))
  assert.deepEqual(files, ['run-1%3Asubagent%3Aagent-1.json'])
  assert.deepEqual(await loadSnapshotIndex(workspaceHash, snapshot.runId), snapshot)

  await deleteSnapshotIndex(workspaceHash, snapshot.runId)
  assert.deepEqual(
    await readdir(join(resolveYachiyoFileHistoryDir(), workspaceHash, 'snapshots')),
    []
  )

  const reservedSnapshot = createSnapshot('CON')
  await saveSnapshotIndex(workspaceHash, reservedSnapshot)
  assert.deepEqual(
    await readdir(join(resolveYachiyoFileHistoryDir(), workspaceHash, 'snapshots')),
    ['%43ON.json']
  )
  assert.deepEqual(await loadSnapshotIndex(workspaceHash, reservedSnapshot.runId), reservedSnapshot)
})

test('snapshotIndex keeps existing portable run ID filenames unchanged', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'snapshot-index-legacy-test-'))
  process.env['YACHIYO_HOME'] = home

  t.after(async () => {
    if (originalHome === undefined) {
      delete process.env['YACHIYO_HOME']
    } else {
      process.env['YACHIYO_HOME'] = originalHome
    }
    await rm(home, { recursive: true, force: true })
  })

  const workspaceHash = 'workspace-1'
  const snapshot = createSnapshot('run-1')
  await saveSnapshotIndex(workspaceHash, snapshot)

  const files = await readdir(join(resolveYachiyoFileHistoryDir(), workspaceHash, 'snapshots'))
  assert.deepEqual(files, ['run-1.json'])
  assert.deepEqual(await loadSnapshotIndex(workspaceHash, snapshot.runId), snapshot)
})
