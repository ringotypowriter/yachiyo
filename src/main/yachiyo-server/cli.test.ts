import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'

import { runCli } from './cli.ts'
import { createInMemoryYachiyoStorage } from './memoryStorage.ts'
import { YachiyoServer } from './YachiyoServer.ts'

test('CLI manages file-based TOML settings and thread commands without sqlite native deps', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-cli-test-'))
  const dbPath = join(root, 'cli.sqlite')
  const settingsPath = join(root, 'config.toml')
  const storage = createInMemoryYachiyoStorage()

  const runCommand = async (args: string[]): Promise<unknown> => {
    let stdout = ''

    await runCli(args, {
      stdout: {
        write(chunk) {
          stdout += String(chunk)
          return true
        }
      },
      createServer: ({ settingsPath: currentSettingsPath }) =>
        new YachiyoServer({
          storage,
          settingsPath: currentSettingsPath,
          ensureThreadWorkspace: async (threadId) => {
            const workspacePath = join(root, '.yachiyo', 'temp-workspace', threadId)
            await mkdir(workspacePath, { recursive: true })
            return workspacePath
          }
        })
    })

    return JSON.parse(stdout)
  }

  try {
    const provider = await runCommand([
      'settings.provider.upsert',
      '--db',
      dbPath,
      '--settings',
      settingsPath,
      '--json',
      JSON.stringify({
        name: 'work',
        type: 'openai',
        apiKey: 'sk-cli',
        baseUrl: 'https://api.openai.com/v1',
        modelList: {
          enabled: ['gpt-5', 'gpt-4.1'],
          disabled: ['o3-mini']
        }
      })
    ])

    assert.equal((provider as { name: string }).name, 'work')
    assert.equal((provider as { type: string }).type, 'openai')

    const payload = await runCommand(['bootstrap', '--db', dbPath, '--settings', settingsPath])
    assert.deepEqual((payload as { threads: unknown[] }).threads, [])
    assert.equal((payload as { config: { providers: unknown[] } }).config.providers.length, 1)
    assert.equal((payload as { settings: { providerName: string } }).settings.providerName, 'work')
    assert.equal((payload as { settings: { provider: string } }).settings.provider, 'openai')
    assert.equal((payload as { settings: { model: string } }).settings.model, 'gpt-5')

    const config = await runCommand(['settings.get', '--db', dbPath, '--settings', settingsPath])
    assert.equal((config as { providers: unknown[] }).providers.length, 1)
    assert.deepEqual(
      (config as { providers: Array<{ modelList: { disabled: string[] } }> }).providers[0]
        ?.modelList.disabled,
      ['o3-mini']
    )

    await runCommand([
      'settings.provider.model.disable',
      '--db',
      dbPath,
      '--settings',
      settingsPath,
      '--json',
      JSON.stringify({
        name: 'work',
        model: 'gpt-5'
      })
    ])

    const disabledConfig = await runCommand([
      'settings.get',
      '--db',
      dbPath,
      '--settings',
      settingsPath
    ])
    assert.deepEqual(
      (disabledConfig as { providers: Array<{ modelList: { enabled: string[] } }> }).providers[0]
        ?.modelList.enabled,
      ['gpt-4.1']
    )
    assert.deepEqual(
      (disabledConfig as { providers: Array<{ modelList: { disabled: string[] } }> }).providers[0]
        ?.modelList.disabled,
      ['gpt-5', 'o3-mini']
    )

    const toml = await readFile(settingsPath, 'utf8')
    assert.match(toml, /\[\[providers\]\]/)
    assert.match(toml, /name = "work"/)

    const thread = await runCommand(['thread.create', '--db', dbPath, '--settings', settingsPath])
    const renamedThread = await runCommand([
      'thread.rename',
      '--db',
      dbPath,
      '--settings',
      settingsPath,
      '--json',
      JSON.stringify({
        threadId: (thread as { id: string }).id,
        title: 'Inbox'
      })
    ])

    assert.equal((renamedThread as { title: string }).title, 'Inbox')

    await runCommand([
      'thread.archive',
      '--db',
      dbPath,
      '--settings',
      settingsPath,
      '--json',
      JSON.stringify({
        threadId: (thread as { id: string }).id
      })
    ])

    const archivedPayload = await runCommand([
      'bootstrap',
      '--db',
      dbPath,
      '--settings',
      settingsPath
    ])
    assert.deepEqual((archivedPayload as { threads: unknown[] }).threads, [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
