import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { runYachiyoCli } from './yachiyoCli.ts'

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
