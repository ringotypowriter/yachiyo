import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { runYachiyoCli } from './yachiyoCli.ts'
import { PluginVersions } from '@yachiyo/runtime/services/plugins/pluginVersions'

test('plugin CLI checks, enables, lists, and disables a broken plugin without executing it', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-cli-plugin-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'plugins'))
  await writeFile(join(root, 'config.toml'), '')
  await writeFile(
    join(root, 'plugins', 'context.ts'),
    `
    const enabled: boolean = true
    export default {apiVersion: 1, hooks: {beforeModel({messages}) {
      if (enabled) return {messages}
    }}}
  `
  )
  const run = async (...args: string[]): Promise<unknown> => {
    let output = ''
    await runYachiyoCli([...args, '--settings', join(root, 'config.toml')], {
      stdout: {
        write: (value) => {
          output += String(value)
          return true
        }
      }
    })
    return JSON.parse(output)
  }
  const checked = (await run('plugin', 'check', 'context.ts')) as {
    hooks: string[]
    revision: string
  }
  assert.deepEqual(checked.hooks, ['beforeModel'])
  assert.match(checked.revision, /^[a-f0-9]{64}$/)
  assert.deepEqual(await run('config', 'get', 'plugins.enabled'), [])
  await run('plugin', 'enable', 'context.ts')
  assert.deepEqual(await run('config', 'get', 'plugins.enabled'), ['context.ts'])
  assert.deepEqual(await run('plugin', 'list'), {
    directory: join(root, 'plugins'),
    plugins: [{ name: 'context.ts', enabled: true, missing: false }]
  })

  await writeFile(join(root, 'plugins', 'context.ts'), `throw new Error('broken plugin')`)
  await assert.rejects(run('plugin', 'check', 'context.ts'), /broken plugin/)
  await run('plugin', 'disable', 'context.ts')
  assert.deepEqual(await run('config', 'get', 'plugins.enabled'), [])
  await assert.rejects(run('plugin', 'enable', 'context.ts'), /broken plugin/)
  assert.deepEqual(await run('config', 'get', 'plugins.enabled'), [])
})

test('enabling a plugin rejects tool registration and directory traversal', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-cli-plugin-invalid-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'plugins'))
  await writeFile(join(root, 'config.toml'), '')
  await writeFile(
    join(root, 'plugins', 'tools.js'),
    `export default {
    apiVersion: 1, tools: {surprise: {}}, hooks: {beforeModel() {}}
  }`
  )
  const options = { stdout: { write: (): boolean => true } }
  await assert.rejects(
    runYachiyoCli(
      ['plugin', 'enable', 'tools.js', '--settings', join(root, 'config.toml')],
      options
    ),
    /supports hooks only/
  )
  await assert.rejects(
    runYachiyoCli(
      ['plugin', 'check', '../outside.ts', '--settings', join(root, 'config.toml')],
      options
    ),
    /Invalid plugin filename/
  )
})

test('plugin CLI trials draft hooks and rolls back active code independently of the draft', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-cli-plugin-versions-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const directory = join(root, 'plugins')
  await mkdir(directory)
  await writeFile(join(root, 'config.toml'), '')
  await writeFile(
    join(root, 'fixture.json'),
    JSON.stringify({ events: [{ hook: 'beforeInput', event: { text: 'hello' } }] })
  )
  const run = async (...args: string[]): Promise<Record<string, unknown>> => {
    let output = ''
    await runYachiyoCli([...args, '--settings', join(root, 'config.toml')], {
      stdout: {
        write: (value) => {
          output += String(value)
          return true
        }
      }
    })
    return JSON.parse(output) as Record<string, unknown>
  }
  const draft = (text: string): string =>
    `export default {apiVersion: 1, hooks: {beforeInput() {return {text: '${text}'}}}}`
  await writeFile(join(directory, 'context.js'), draft('first'))
  const first = await run('plugin', 'enable', 'context.js')
  await writeFile(join(directory, 'context.js'), draft('second'))
  assert.equal(
    (await new PluginVersions(directory).readEnabled(['context.js']))[0].revision,
    first.revision
  )
  const trial = await run('plugin', 'trial', 'context.js', join(root, 'fixture.json'))
  assert.deepEqual((trial.events as Array<{ result: unknown }>)[0].result, { text: 'second' })
  const second = await run('plugin', 'activate', 'context.js')
  assert.notEqual(first.revision, second.revision)
  await writeFile(join(directory, 'context.js'), 'broken draft')
  const restored = await run('plugin', 'rollback', 'context.js')
  assert.equal(restored.revision, first.revision)
  assert.equal(restored.enabled, true)
  const status = await run('plugin', 'status', 'context.js')
  assert.equal(status.active, first.revision)
  assert.equal(status.previous, second.revision)
  assert.equal((status.revisions as string[]).length, 2)
})
