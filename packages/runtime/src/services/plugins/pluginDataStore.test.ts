import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { PluginDataStore, PluginStateConflictError } from './pluginDataStore.ts'
import { readPluginSources } from './pluginFiles.ts'
import { PluginVersions } from './pluginVersions.ts'
import { PluginSession } from './pluginSession.ts'
import { PluginState } from './pluginState.ts'

async function directory(t: test.TestContext): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'yachiyo-plugin-data-'))
  t.after(() => rm(path, { recursive: true, force: true }))
  return path
}

test('concurrent state writers cannot overwrite each other and readers see complete JSON', async (t) => {
  const path = await directory(t)
  const stores = [new PluginDataStore(path), new PluginDataStore(path)]
  const key = ['context.ts', 'thread', '1', 'memory']
  assert.deepEqual(await stores[0].read(key), { version: 0, value: null })
  const writes = await Promise.allSettled(
    stores.map((store, i) => store.write(key, 0, { count: i }))
  )
  const winner = writes.findIndex((write) => write.status === 'fulfilled')
  assert.equal(writes.filter((write) => write.status === 'fulfilled').length, 1)
  const failed = writes.find((write) => write.status === 'rejected') as PromiseRejectedResult
  assert.ok(failed.reason instanceof PluginStateConflictError)
  assert.deepEqual(await new PluginDataStore(path).read(key), {
    version: 1,
    value: { count: winner }
  })
  await assert.rejects(stores[0].write(key, 0, 'stale'), PluginStateConflictError)
  await stores[0].write(key, 1, null)
  assert.deepEqual(await stores[1].read(key), { version: 2, value: null })
})

test('activated sources survive draft edits, process restarts and rollbacks', async (t) => {
  const path = await directory(t)
  const name = 'context.ts'
  const versions = new PluginVersions(path)
  await writeFile(join(path, name), 'export default { apiVersion: 1, hooks: { beforeModel() {} } }')
  const [first] = await readPluginSources([name], path)
  await versions.activate(first)
  await writeFile(join(path, name), 'export default { apiVersion: 1, hooks: { afterTool() {} } }')
  assert.deepEqual(await new PluginVersions(path).readEnabled([name]), [first])
  const [second] = await readPluginSources([name], path)
  await versions.activate(second)
  assert.deepEqual(await versions.readEnabled([name]), [second])
  await versions.rollback(name)
  assert.deepEqual(await versions.readEnabled([name]), [first])
  const status = await versions.status(name)
  assert.equal(status.previous, second.revision)
  assert.deepEqual(status.revisions.sort(), [first.revision, second.revision].sort())
  await assert.rejects(versions.rollback(name, '../bad'), /Invalid/)
})

test('previously enabled draft files are pinned once on upgrade', async (t) => {
  const path = await directory(t)
  await writeFile(join(path, 'context.js'), 'export default {}')
  const versions = new PluginVersions(path)
  const original = await versions.readEnabled(['context.js'])
  await writeFile(join(path, 'context.js'), 'broken draft')
  assert.deepEqual(await versions.readEnabled(['context.js']), original)
})

test('hooks keep scoped state across sessions and can handle a state conflict', async (t) => {
  const path = await directory(t)
  const sources = [
    {
      name: 'state.js',
      revision: 'test',
      source: `
    export default {apiVersion: 1, hooks: {
      async beforeInput({text}, {state}) {
        const previous = await state.read('thread', 'visits')
        await state.write('thread', 'visits', previous.version, (previous.value ?? 0) + 1)
        try { await state.write('thread', 'visits', previous.version, 99) }
        catch (error) { if (!error.message.includes('concurrently')) throw error }
        return {text: text + ':' + (previous.value ?? 0)}
      }
    }}
  `
    }
  ]
  const context = { runId: 'r', threadId: 't', workspacePath: '/tmp', runMode: 'auto' as const }
  for (let i = 0; i < 2; i++) {
    const session = await PluginSession.create(sources, {
      state: new PluginState({ directory: path })
    })
    try {
      assert.deepEqual(await session.dispatch('beforeInput', context, { text: 'hello' }), {
        text: `hello:${i}`
      })
    } finally {
      await session.dispose()
    }
  }
  const session = await PluginSession.create(sources, {
    state: new PluginState({ directory: path })
  })
  t.after(() => session.dispose())
  assert.deepEqual(
    await session.dispatch('beforeInput', { ...context, threadId: 'another' }, { text: 'hello' }),
    { text: 'hello:0' }
  )
})
