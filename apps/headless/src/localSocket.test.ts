import { connectHeadless } from '@yachiyo/cli/services/headless'
import { isSocketRunning, listenLocalSocket } from '@yachiyo/runtime/appServer/cliSocket'
import type { YachiyoServerEvent } from '@yachiyo/shared/protocol'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

test('local RPC restricts methods and thread events, protects the socket and disconnects malformed peers', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'yh-rpc-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'rpc.sock')
  const listeners = new Set<(event: YachiyoServerEvent) => void>()
  const options = {
    path,
    target: { echo: (value: unknown): unknown => value },
    subscribe: (fn: (event: YachiyoServerEvent) => void): (() => void) => {
      listeners.add(fn)
      return () => {
        listeners.delete(fn)
      }
    }
  }
  const host = await listenLocalSocket(options)
  t.after(() => host.close())
  const connection = await connectHeadless(path)
  t.after(() => connection.client.close())
  assert.equal((await stat(path)).mode & 0o777, 0o600)
  assert.equal(await isSocketRunning(path), true)
  await assert.rejects(listenLocalSocket(options), /already running/)
  await assert.rejects(connection.client.call('constructor', []), /Unknown RPC method/)
  assert.equal(await connection.client.call('echo', ['hello 世界']), 'hello 世界')

  const events: unknown[] = []
  connection.client.subscribe((event) => events.push(event))
  await connection.client.call('watchThread', ['mine'])
  for (const threadId of ['another', 'mine']) {
    const event = { type: 'run.cancelled', threadId, runId: 'run' } as YachiyoServerEvent
    for (const listener of listeners) listener(event)
  }
  await connection.client.call('echo', ['barrier'])
  assert.deepEqual(events, [{ type: 'run.cancelled', threadId: 'mine', runId: 'run' }])

  const malformed = connect(path)
  await once(malformed, 'connect')
  const disconnected = once(malformed, 'close')
  malformed.write('{"kind":"rpc:request","method":"echo"}\n')
  await disconnected
  assert.equal(await connection.client.call('echo', ['still serving']), 'still serving')
  const oversized = {
    type: 'message.delta',
    threadId: 'mine',
    runId: 'run',
    delta: 'x'.repeat(16 * 1024 * 1024)
  } as YachiyoServerEvent
  assert.doesNotThrow(() => {
    for (const listener of listeners) listener(oversized)
  })
  await connection.closed
  assert.equal(await isSocketRunning(path), true)
})

test('startup never unlinks a regular file and clients report a stopped daemon', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'yh-file-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'rpc.sock')
  await writeFile(path, 'keep me')
  await assert.rejects(
    listenLocalSocket({ path, target: {}, subscribe: () => () => {} }),
    /Refusing/
  )
  assert.equal(await readFile(path, 'utf8'), 'keep me')
  await assert.rejects(connectHeadless(join(root, 'missing.sock')), /not running/)
})

test('startup recovers the owned socket left behind by an exited process', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'yh-stale-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'rpc.sock')
  execFileSync(process.execPath, [
    '-e',
    'require("node:net").createServer().listen(process.argv[1], () => process.exit(0))',
    path
  ])
  assert.ok((await stat(path)).isSocket())
  assert.equal(await isSocketRunning(path), false)
  const host = await listenLocalSocket({ path, target: {}, subscribe: () => () => {} })
  try {
    assert.equal(await isSocketRunning(path), true)
  } finally {
    await host.close()
  }
})
