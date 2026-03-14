import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import test from 'node:test'

const execFileAsync = promisify(execFile)

test('CLI manages file-based TOML settings and thread commands', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-cli-test-'))
  const dbPath = join(root, 'cli.sqlite')
  const settingsPath = join(root, 'config.toml')
  const cliPath = new URL('./cli.ts', import.meta.url)

  try {
    const upserted = await execFileAsync(process.execPath, [
      '--experimental-strip-types',
      cliPath.pathname,
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

    const provider = JSON.parse(upserted.stdout)
    assert.equal(provider.name, 'work')
    assert.equal(provider.type, 'openai')

    const bootstrapped = await execFileAsync(process.execPath, [
      '--experimental-strip-types',
      cliPath.pathname,
      'bootstrap',
      '--db',
      dbPath,
      '--settings',
      settingsPath
    ])

    const payload = JSON.parse(bootstrapped.stdout)
    assert.deepEqual(payload.threads, [])
    assert.equal(payload.config.providers.length, 1)
    assert.equal(payload.settings.providerName, 'work')
    assert.equal(payload.settings.provider, 'openai')
    assert.equal(payload.settings.model, 'gpt-5')

    const config = await execFileAsync(process.execPath, [
      '--experimental-strip-types',
      cliPath.pathname,
      'settings.get',
      '--db',
      dbPath,
      '--settings',
      settingsPath
    ])

    const settings = JSON.parse(config.stdout)
    assert.equal(settings.providers.length, 1)
    assert.deepEqual(settings.providers[0]?.modelList.disabled, ['o3-mini'])

    await execFileAsync(process.execPath, [
      '--experimental-strip-types',
      cliPath.pathname,
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

    const afterDisable = await execFileAsync(process.execPath, [
      '--experimental-strip-types',
      cliPath.pathname,
      'settings.get',
      '--db',
      dbPath,
      '--settings',
      settingsPath
    ])

    const disabledConfig = JSON.parse(afterDisable.stdout)
    assert.deepEqual(disabledConfig.providers[0]?.modelList.enabled, ['gpt-4.1'])
    assert.deepEqual(disabledConfig.providers[0]?.modelList.disabled, ['gpt-5', 'o3-mini'])

    const toml = await readFile(settingsPath, 'utf8')
    assert.match(toml, /\[\[providers\]\]/)
    assert.match(toml, /name = "work"/)

    const created = await execFileAsync(process.execPath, [
      '--experimental-strip-types',
      cliPath.pathname,
      'thread.create',
      '--db',
      dbPath,
      '--settings',
      settingsPath
    ])

    const thread = JSON.parse(created.stdout)

    const renamed = await execFileAsync(process.execPath, [
      '--experimental-strip-types',
      cliPath.pathname,
      'thread.rename',
      '--db',
      dbPath,
      '--settings',
      settingsPath,
      '--json',
      JSON.stringify({
        threadId: thread.id,
        title: 'Inbox'
      })
    ])

    const renamedThread = JSON.parse(renamed.stdout)
    assert.equal(renamedThread.title, 'Inbox')

    await execFileAsync(process.execPath, [
      '--experimental-strip-types',
      cliPath.pathname,
      'thread.archive',
      '--db',
      dbPath,
      '--settings',
      settingsPath,
      '--json',
      JSON.stringify({
        threadId: thread.id
      })
    ])

    const afterArchive = await execFileAsync(process.execPath, [
      '--experimental-strip-types',
      cliPath.pathname,
      'bootstrap',
      '--db',
      dbPath,
      '--settings',
      settingsPath
    ])

    const archivedPayload = JSON.parse(afterArchive.stdout)
    assert.deepEqual(archivedPayload.threads, [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
