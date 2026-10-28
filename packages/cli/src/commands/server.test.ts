import { publishAppServerAddress } from '@yachiyo/runtime/appServer/discovery'
import { AppHostBridge } from '@yachiyo/runtime/appServer/hostBridge'
import { listenAppServer } from '@yachiyo/runtime/appServer/listener'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { runYachiyoCli } from '../yachiyoCli.ts'

test('server CLI reports status without credentials and stops only a detached server', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'y-server-cli-'))
  const previous = process.env.YACHIYO_HOME
  process.env.YACHIYO_HOME = home
  t.after(async () => {
    if (previous === undefined) delete process.env.YACHIYO_HOME
    else process.env.YACHIYO_HOME = previous
    await rm(home, { recursive: true, force: true })
  })
  let nativeHost = true
  let stopped = false
  const server = await listenAppServer({
    host: new AppHostBridge(),
    target: {},
    subscribe: () => () => {},
    adminTarget: {
      'server.status': () => ({ nativeHost, pid: 123 }),
      'server.shutdown': () => {
        stopped = true
        return true
      }
    }
  })
  t.after(() => server.close())
  await publishAppServerAddress(home, server.address)
  let output = ''
  const options = {
    stdout: {
      write: (text: string) => {
        output += text
        return true
      }
    }
  }
  await runYachiyoCli(['server', 'status'], options)
  assert.deepEqual(JSON.parse(output), { nativeHost: true, pid: 123 })
  assert.equal(output.includes(server.address.token), false)
  await assert.rejects(runYachiyoCli(['server', 'stop'], options), /Quit the desktop app/)
  assert.equal(stopped, false)
  nativeHost = false
  output = ''
  await runYachiyoCli(['server', 'stop'], options)
  assert.equal(stopped, true)
  assert.deepEqual(JSON.parse(output), { stopping: true })
})
