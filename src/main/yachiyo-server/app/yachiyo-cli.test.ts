import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'

import { runYachiyoCli } from './yachiyo-cli.ts'
import { createInMemoryYachiyoStorage } from '../storage/memoryStorage.ts'
import { YachiyoServer } from './YachiyoServer.ts'
import { readSoulDocument, upsertDailySoulTrait, removeSoulTrait } from '../runtime/soul.ts'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeRunCommand(): (args: string[]) => Promise<unknown> {
  return async (args: string[]) => {
    let stdout = ''
    await runYachiyoCli(args, {
      stdout: {
        write(chunk) {
          stdout += String(chunk)
          return true
        }
      },
      readSoulDocument: (input) => readSoulDocument(input),
      upsertDailySoulTrait: (input) => upsertDailySoulTrait(input),
      removeSoulTrait: (input) => removeSoulTrait(input)
    })
    return JSON.parse(stdout)
  }
}

// Soul commands bypass the server and use the soul path flag directly.
function makeRunSoulCommand(): (args: string[]) => Promise<unknown> {
  return async (args: string[]) => {
    let stdout = ''
    await runYachiyoCli(args, {
      stdout: {
        write(chunk) {
          stdout += String(chunk)
          return true
        }
      },
      readSoulDocument: (input) => readSoulDocument(input),
      upsertDailySoulTrait: (input) => upsertDailySoulTrait(input),
      removeSoulTrait: (input) => removeSoulTrait(input)
    })
    return JSON.parse(stdout)
  }
}

// ---------------------------------------------------------------------------
// Soul traits tests
// ---------------------------------------------------------------------------

test('soul traits list - empty document', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-cli-soul-'))
  const soulPath = join(root, 'SOUL.md')

  try {
    const run = makeRunSoulCommand()
    const result = await run(['soul', 'traits', 'list', '--soul', soulPath])
    assert.deepEqual(result, [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('soul traits add - creates and persists a trait', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-cli-soul-'))
  const soulPath = join(root, 'SOUL.md')

  try {
    const run = makeRunSoulCommand()
    const result = (await run([
      'soul',
      'traits',
      'add',
      'Prefers concise responses',
      '--soul',
      soulPath
    ])) as {
      added: string
      traits: Array<{ index: number; trait: string }>
    }
    assert.equal(result.added, 'Prefers concise responses')
    assert.equal(result.traits.length, 1)
    assert.equal(result.traits[0]?.trait, 'Prefers concise responses')
    assert.equal(result.traits[0]?.index, 0)

    // Persists: list should show it
    const list = (await run(['soul', 'traits', 'list', '--soul', soulPath])) as Array<{
      index: number
      trait: string
    }>
    assert.equal(list.length, 1)
    assert.equal(list[0]?.trait, 'Prefers concise responses')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('soul traits add - multiple traits, deduplicated', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-cli-soul-'))
  const soulPath = join(root, 'SOUL.md')

  try {
    const run = makeRunSoulCommand()
    await run(['soul', 'traits', 'add', 'Trait A', '--soul', soulPath])
    await run(['soul', 'traits', 'add', 'Trait B', '--soul', soulPath])
    await run(['soul', 'traits', 'add', 'Trait A', '--soul', soulPath]) // duplicate

    const list = (await run(['soul', 'traits', 'list', '--soul', soulPath])) as Array<{
      index: number
      trait: string
    }>
    assert.equal(list.length, 2)
    assert.deepEqual(
      list.map((t) => t.trait),
      ['Trait A', 'Trait B']
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('soul traits remove by index', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-cli-soul-'))
  const soulPath = join(root, 'SOUL.md')

  try {
    const run = makeRunSoulCommand()
    await run(['soul', 'traits', 'add', 'Trait A', '--soul', soulPath])
    await run(['soul', 'traits', 'add', 'Trait B', '--soul', soulPath])
    await run(['soul', 'traits', 'add', 'Trait C', '--soul', soulPath])

    const result = (await run(['soul', 'traits', 'remove', '1', '--soul', soulPath])) as {
      removed: string
      traits: Array<{ index: number; trait: string }>
    }
    assert.equal(result.removed, '1')
    assert.equal(result.traits.length, 2)
    assert.deepEqual(
      result.traits.map((t) => t.trait),
      ['Trait A', 'Trait C']
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('soul traits remove by text', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-cli-soul-'))
  const soulPath = join(root, 'SOUL.md')

  try {
    const run = makeRunSoulCommand()
    await run(['soul', 'traits', 'add', 'Trait A', '--soul', soulPath])
    await run(['soul', 'traits', 'add', 'Trait B', '--soul', soulPath])

    const result = (await run(['soul', 'traits', 'remove', 'Trait A', '--soul', soulPath])) as {
      traits: Array<{ trait: string }>
    }
    assert.equal(result.traits.length, 1)
    assert.equal(result.traits[0]?.trait, 'Trait B')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('soul traits remove by out-of-range index throws', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-cli-soul-'))
  const soulPath = join(root, 'SOUL.md')

  try {
    const run = makeRunSoulCommand()
    await run(['soul', 'traits', 'add', 'Only one', '--soul', soulPath])

    await assert.rejects(
      () => run(['soul', 'traits', 'remove', '99', '--soul', soulPath]),
      /out of range/
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Provider tests
// ---------------------------------------------------------------------------

test('provider list - empty', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-cli-provider-'))

  try {
    const run = makeRunCommand()
    const result = (await run([
      'provider',
      'list',
      '--settings',
      join(root, 'config.toml')
    ])) as unknown[]
    assert.deepEqual(result, [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('provider list - shows providers with redacted apiKey', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-cli-provider-'))
  const settingsPath = join(root, 'config.toml')

  try {
    const run = makeRunCommand()

    // Add a provider first via the server's upsert command
    await run(['provider', 'update', 'nonexistent', '--settings', settingsPath]).catch(() => null) // expected to fail - no such provider yet

    // Upsert via raw server call - use settings.provider.upsert from cli.ts instead
    // Actually let's use the old cli to set up state, then test new cli reads it
    // But both share the same settings file - let's do it via yachiyo-cli provider update after creating
    // We'll use a workaround: add provider via the existing internal API by using a custom server
    const storage = createInMemoryYachiyoStorage()
    const server = new YachiyoServer({
      storage,
      settingsPath,
      ensureThreadWorkspace: async (threadId) => {
        const p = join(root, '.yachiyo', 'temp-workspace', threadId)
        await mkdir(p, { recursive: true })
        return p
      }
    })
    await server.upsertProvider({
      id: 'test-id-1',
      name: 'my-provider',
      type: 'anthropic',
      apiKey: 'sk-secret-key',
      baseUrl: '',
      modelList: { enabled: ['claude-opus-4-6'], disabled: [] }
    })
    await server.close()

    // Now list via CLI with shared settings file
    let stdout = ''
    await runYachiyoCli(['provider', 'list', '--settings', settingsPath], {
      stdout: {
        write(chunk) {
          stdout += String(chunk)
          return true
        }
      }
    })

    const providers = JSON.parse(stdout) as Array<{ name: string; apiKey: string }>
    assert.equal(providers.length, 1)
    assert.equal(providers[0]?.name, 'my-provider')
    assert.equal(providers[0]?.apiKey, '***', 'apiKey must be redacted')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('provider show - redacts apiKey', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-cli-provider-'))
  const settingsPath = join(root, 'config.toml')

  try {
    const storage = createInMemoryYachiyoStorage()

    const setupServer = new YachiyoServer({
      storage,
      settingsPath,
      ensureThreadWorkspace: async (threadId) => {
        const p = join(root, '.yachiyo', 'temp-workspace', threadId)
        await mkdir(p, { recursive: true })
        return p
      }
    })
    await setupServer.upsertProvider({
      id: 'prov-uuid',
      name: 'work',
      type: 'openai',
      apiKey: 'sk-real-key',
      baseUrl: '',
      modelList: { enabled: ['gpt-5'], disabled: [] }
    })
    await setupServer.close()

    let stdout = ''
    await runYachiyoCli(['provider', 'show', 'work', '--settings', settingsPath], {
      stdout: {
        write(chunk) {
          stdout += String(chunk)
          return true
        }
      }
    })

    const provider = JSON.parse(stdout) as { name: string; type: string; apiKey: string }
    assert.equal(provider.name, 'work')
    assert.equal(provider.type, 'openai')
    assert.equal(provider.apiKey, '***', 'apiKey must be redacted')
    assert.ok(
      !JSON.stringify(provider).includes('sk-real-key'),
      'raw key must never appear in output'
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('provider models - lists all enabled models across providers when no argument given', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-cli-provider-'))
  const settingsPath = join(root, 'config.toml')

  try {
    const storage = createInMemoryYachiyoStorage()

    const setupServer = new YachiyoServer({
      storage,
      settingsPath,
      ensureThreadWorkspace: async (threadId) => {
        const p = join(root, '.yachiyo', 'temp-workspace', threadId)
        await mkdir(p, { recursive: true })
        return p
      }
    })
    await setupServer.upsertProvider({
      id: 'prov-a',
      name: 'provider-a',
      type: 'openai',
      apiKey: 'key-a',
      baseUrl: '',
      modelList: { enabled: ['gpt-5', 'gpt-5-mini'], disabled: ['gpt-4'] }
    })
    await setupServer.upsertProvider({
      id: 'prov-b',
      name: 'provider-b',
      type: 'anthropic',
      apiKey: 'key-b',
      baseUrl: '',
      modelList: { enabled: ['claude-sonnet-4-5'], disabled: [] }
    })
    await setupServer.close()

    let stdout = ''
    await runYachiyoCli(['provider', 'models', '--settings', settingsPath], {
      stdout: {
        write(chunk) {
          stdout += String(chunk)
          return true
        }
      }
    })

    const result = JSON.parse(stdout) as Array<{ provider: string; model: string }>
    assert.deepEqual(result, [
      { provider: 'provider-a', model: 'gpt-5' },
      { provider: 'provider-a', model: 'gpt-5-mini' },
      { provider: 'provider-b', model: 'claude-sonnet-4-5' }
    ])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('provider set-default - moves provider to first position', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-cli-provider-'))
  const settingsPath = join(root, 'config.toml')

  try {
    const storage = createInMemoryYachiyoStorage()

    const setupServer = new YachiyoServer({
      storage,
      settingsPath,
      ensureThreadWorkspace: async (threadId) => {
        const p = join(root, '.yachiyo', 'temp-workspace', threadId)
        await mkdir(p, { recursive: true })
        return p
      }
    })
    await setupServer.upsertProvider({
      id: 'prov-a',
      name: 'provider-a',
      type: 'anthropic',
      apiKey: 'key-a',
      baseUrl: '',
      modelList: { enabled: ['model-a'], disabled: [] }
    })
    await setupServer.upsertProvider({
      id: 'prov-b',
      name: 'provider-b',
      type: 'openai',
      apiKey: 'key-b',
      baseUrl: '',
      modelList: { enabled: ['model-b'], disabled: [] }
    })
    await setupServer.close()

    let stdout = ''
    await runYachiyoCli(['provider', 'set-default', 'provider-b', '--settings', settingsPath], {
      stdout: {
        write(chunk) {
          stdout += String(chunk)
          return true
        }
      }
    })

    const result = JSON.parse(stdout) as {
      defaultProvider: { name: string }
      defaultModel: { providerName: string; model: string } | null
      providers: Array<{ name: string }>
    }
    assert.equal(result.defaultProvider.name, 'provider-b', 'provider-b should be new default')
    assert.equal(result.providers[0]?.name, 'provider-b', 'provider-b should be first in list')
    assert.equal(result.providers[1]?.name, 'provider-a')
    assert.equal(
      result.defaultModel?.providerName,
      'provider-b',
      'defaultModel should point to provider-b'
    )
    assert.equal(
      result.defaultModel?.model,
      'model-b',
      'defaultModel should pick first enabled model'
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('provider set-default --model picks the specified model', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-cli-provider-'))
  const settingsPath = join(root, 'config.toml')

  try {
    const storage = createInMemoryYachiyoStorage()

    const setupServer = new YachiyoServer({
      storage,
      settingsPath,
      ensureThreadWorkspace: async (threadId) => {
        const p = join(root, '.yachiyo', 'temp-workspace', threadId)
        await mkdir(p, { recursive: true })
        return p
      }
    })
    await setupServer.upsertProvider({
      id: 'prov-a',
      name: 'provider-a',
      type: 'openai',
      apiKey: 'key-a',
      baseUrl: '',
      modelList: { enabled: ['model-x', 'model-y'], disabled: [] }
    })
    await setupServer.close()

    let stdout = ''
    await runYachiyoCli(
      ['provider', 'set-default', 'provider-a', '--model', 'model-y', '--settings', settingsPath],
      {
        stdout: {
          write(chunk) {
            stdout += String(chunk)
            return true
          }
        }
      }
    )

    const result = JSON.parse(stdout) as {
      defaultModel: { providerName: string; model: string } | null
    }
    assert.equal(result.defaultModel?.providerName, 'provider-a')
    assert.equal(result.defaultModel?.model, 'model-y', 'should pick the explicit --model value')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('provider set-default --model rejects a model not enabled on the provider', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-cli-provider-'))
  const settingsPath = join(root, 'config.toml')

  try {
    const storage = createInMemoryYachiyoStorage()

    const setupServer = new YachiyoServer({
      storage,
      settingsPath,
      ensureThreadWorkspace: async (threadId) => {
        const p = join(root, '.yachiyo', 'temp-workspace', threadId)
        await mkdir(p, { recursive: true })
        return p
      }
    })
    await setupServer.upsertProvider({
      id: 'prov-a',
      name: 'provider-a',
      type: 'openai',
      apiKey: 'key-a',
      baseUrl: '',
      modelList: { enabled: ['model-x'], disabled: [] }
    })
    await setupServer.close()

    await assert.rejects(
      () =>
        runYachiyoCli(
          [
            'provider',
            'set-default',
            'provider-a',
            '--model',
            'nonexistent-model',
            '--settings',
            settingsPath
          ],
          {
            stdout: {
              write() {
                return true
              }
            }
          }
        ),
      /not enabled on provider/
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('provider set-default - unknown provider throws', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-cli-provider-'))
  const settingsPath = join(root, 'config.toml')

  try {
    await assert.rejects(
      () =>
        runYachiyoCli(['provider', 'set-default', 'nonexistent', '--settings', settingsPath], {
          stdout: {
            write() {
              return true
            }
          }
        }),
      /Unknown provider/
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('provider update - patches provider fields', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-cli-provider-'))
  const settingsPath = join(root, 'config.toml')

  try {
    const storage = createInMemoryYachiyoStorage()

    const setupServer = new YachiyoServer({
      storage,
      settingsPath,
      ensureThreadWorkspace: async (threadId) => {
        const p = join(root, '.yachiyo', 'temp-workspace', threadId)
        await mkdir(p, { recursive: true })
        return p
      }
    })
    await setupServer.upsertProvider({
      id: 'prov-1',
      name: 'my-prov',
      type: 'anthropic',
      apiKey: 'old-key',
      baseUrl: '',
      modelList: { enabled: ['model-1'], disabled: [] }
    })
    await setupServer.close()

    let stdout = ''
    await runYachiyoCli(
      [
        'provider',
        'update',
        'my-prov',
        '--settings',
        settingsPath,
        '--payload',
        JSON.stringify({ baseUrl: 'https://custom.api.example.com' })
      ],
      {
        stdout: {
          write(chunk) {
            stdout += String(chunk)
            return true
          }
        }
      }
    )

    const result = JSON.parse(stdout) as { name: string; baseUrl: string; apiKey: string }
    assert.equal(result.name, 'my-prov')
    assert.equal(result.baseUrl, 'https://custom.api.example.com')
    assert.equal(result.apiKey, '***', 'apiKey must be redacted in update output')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Config tests
// ---------------------------------------------------------------------------

test('config get - full config (no path)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-cli-config-'))
  const settingsPath = join(root, 'config.toml')

  try {
    let stdout = ''
    await runYachiyoCli(['config', 'get', '--settings', settingsPath], {
      stdout: {
        write(chunk) {
          stdout += String(chunk)
          return true
        }
      }
    })

    const config = JSON.parse(stdout) as { providers: unknown[]; memory: { enabled: boolean } }
    assert.ok(Array.isArray(config.providers))
    assert.equal(typeof config.memory.enabled, 'boolean')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('config get - by dot path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-cli-config-'))
  const settingsPath = join(root, 'config.toml')

  try {
    let stdout = ''
    await runYachiyoCli(['config', 'get', 'memory.enabled', '--settings', settingsPath], {
      stdout: {
        write(chunk) {
          stdout += String(chunk)
          return true
        }
      }
    })

    const value = JSON.parse(stdout)
    assert.equal(value, false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('config set - boolean value persists', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-cli-config-'))
  const settingsPath = join(root, 'config.toml')

  try {
    const runCmd = async (args: string[]): Promise<unknown> => {
      let stdout = ''
      await runYachiyoCli(args, {
        stdout: {
          write(chunk) {
            stdout += String(chunk)
            return true
          }
        }
      })
      return JSON.parse(stdout)
    }

    const setResult = (await runCmd([
      'config',
      'set',
      'memory.enabled',
      'true',
      '--settings',
      settingsPath
    ])) as {
      path: string
      value: boolean
      ok: boolean
    }
    assert.equal(setResult.ok, true)
    assert.equal(setResult.path, 'memory.enabled')
    assert.equal(setResult.value, true)

    // Verify it persisted
    const getResult = await runCmd(['config', 'get', 'memory.enabled', '--settings', settingsPath])
    assert.equal(getResult, true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('config set - string value persists', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-cli-config-'))
  const settingsPath = join(root, 'config.toml')

  try {
    const runCmd = async (args: string[]): Promise<unknown> => {
      let stdout = ''
      await runYachiyoCli(args, {
        stdout: {
          write(chunk) {
            stdout += String(chunk)
            return true
          }
        }
      })
      return JSON.parse(stdout)
    }

    await runCmd([
      'config',
      'set',
      'memory.baseUrl',
      '"http://localhost:14242"',
      '--settings',
      settingsPath
    ])

    const value = await runCmd(['config', 'get', 'memory.baseUrl', '--settings', settingsPath])
    assert.equal(value, 'http://localhost:14242')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('config get - redacts provider apiKey in nested path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-cli-config-'))
  const settingsPath = join(root, 'config.toml')

  try {
    const storage = createInMemoryYachiyoStorage()

    const setupServer = new YachiyoServer({
      storage,
      settingsPath,
      ensureThreadWorkspace: async (threadId) => {
        const p = join(root, '.yachiyo', 'temp-workspace', threadId)
        await mkdir(p, { recursive: true })
        return p
      }
    })
    await setupServer.upsertProvider({
      id: 'p-1',
      name: 'safe-test',
      type: 'anthropic',
      apiKey: 'sk-super-secret',
      baseUrl: '',
      modelList: { enabled: ['model-1'], disabled: [] }
    })
    await setupServer.close()

    let stdout = ''
    await runYachiyoCli(['config', 'get', 'providers', '--settings', settingsPath], {
      stdout: {
        write(chunk) {
          stdout += String(chunk)
          return true
        }
      }
    })

    const providers = JSON.parse(stdout) as Array<{ apiKey: string }>
    assert.equal(providers[0]?.apiKey, '***')
    assert.ok(
      !JSON.stringify(providers).includes('sk-super-secret'),
      'raw apiKey must never appear in config get output'
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Error handling tests
// ---------------------------------------------------------------------------

test('unknown namespace throws with helpful message', async () => {
  await assert.rejects(
    () =>
      runYachiyoCli(['bogus', 'command'], {
        stdout: {
          write() {
            return true
          }
        },
        createConfigService: () => {
          throw new Error('should not create config service')
        }
      }),
    /Unknown namespace.*bogus/
  )
})

test('missing namespace throws usage message', async () => {
  await assert.rejects(
    () =>
      runYachiyoCli([], {
        stdout: {
          write() {
            return true
          }
        }
      }),
    /Usage/
  )
})

test('soul traits remove - unknown text throws', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-cli-soul-err-'))
  const soulPath = join(root, 'SOUL.md')

  try {
    const run = makeRunSoulCommand()
    await run(['soul', 'traits', 'add', 'existing trait', '--soul', soulPath])

    await assert.rejects(
      () => run(['soul', 'traits', 'remove', 'nonexistent trait', '--soul', soulPath]),
      /Trait not found/
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('provider show - unknown provider throws', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-cli-provider-err-'))
  const settingsPath = join(root, 'config.toml')

  try {
    await assert.rejects(
      () =>
        runYachiyoCli(['provider', 'show', 'does-not-exist', '--settings', settingsPath], {
          stdout: {
            write() {
              return true
            }
          }
        }),
      /Unknown provider/
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Agent (subagentProfiles) tests
// ---------------------------------------------------------------------------

function makeRunAgentCommand(settingsPath: string): (args: string[]) => Promise<unknown> {
  return async (args: string[]) => {
    let stdout = ''
    await runYachiyoCli([...args, '--settings', settingsPath], {
      stdout: {
        write(chunk) {
          stdout += String(chunk)
          return true
        }
      }
    })
    return JSON.parse(stdout)
  }
}

test('agent list - returns default profiles from fresh config', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-cli-agent-'))
  const settingsPath = join(root, 'config.toml')

  try {
    const run = makeRunAgentCommand(settingsPath)
    const result = (await run(['agent', 'list'])) as Array<{ id: string; name: string }>
    assert.ok(Array.isArray(result))
    assert.ok(result.length >= 1, 'default config has at least one subagent profile')
    assert.ok(result.every((a) => typeof a.id === 'string' && typeof a.name === 'string'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('agent add - creates agent with generated id', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-cli-agent-'))
  const settingsPath = join(root, 'config.toml')

  try {
    const run = makeRunAgentCommand(settingsPath)
    const payload = JSON.stringify({
      name: 'My Test Agent',
      command: 'npx',
      args: ['-y', 'my-agent'],
      description: 'For testing',
      env: { AGENT_MODE: 'test' }
    })
    const result = (await run(['agent', 'add', '--payload', payload])) as {
      added: {
        id: string
        name: string
        enabled: boolean
        command: string
        args: string[]
        env: Record<string, string>
      }
      agents: unknown[]
    }
    assert.ok(typeof result.added.id === 'string' && result.added.id.length > 0, 'id is generated')
    assert.equal(result.added.name, 'My Test Agent')
    assert.equal(result.added.enabled, true)
    assert.equal(result.added.command, 'npx')
    assert.deepEqual(result.added.args, ['-y', 'my-agent'])
    assert.deepEqual(result.added.env, { AGENT_MODE: 'test' })
    assert.ok(result.agents.length >= 2, 'default + newly added agent')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('agent add - explicit id is preserved', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-cli-agent-'))
  const settingsPath = join(root, 'config.toml')

  try {
    const run = makeRunAgentCommand(settingsPath)
    const payload = JSON.stringify({
      id: 'my-explicit-id',
      name: 'Explicit ID Agent',
      command: 'node',
      args: ['agent.js']
    })
    const result = (await run(['agent', 'add', '--payload', payload])) as {
      added: { id: string }
    }
    assert.equal(result.added.id, 'my-explicit-id')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('agent add - persists so subsequent list shows new agent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-cli-agent-'))
  const settingsPath = join(root, 'config.toml')

  try {
    const run = makeRunAgentCommand(settingsPath)
    await run([
      'agent',
      'add',
      '--payload',
      JSON.stringify({ id: 'persisted-agent', name: 'Persisted', command: 'bash' })
    ])

    const list = (await run(['agent', 'list'])) as Array<{ id: string }>
    assert.ok(
      list.some((a) => a.id === 'persisted-agent'),
      'persisted agent appears in list'
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('agent add - missing name throws', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-cli-agent-'))
  const settingsPath = join(root, 'config.toml')

  try {
    await assert.rejects(
      () =>
        runYachiyoCli(
          [
            'agent',
            'add',
            '--payload',
            JSON.stringify({ command: 'bash' }),
            '--settings',
            settingsPath
          ],
          {
            stdout: {
              write() {
                return true
              }
            }
          }
        ),
      /name is required/
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('agent add - missing command throws', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-cli-agent-'))
  const settingsPath = join(root, 'config.toml')

  try {
    await assert.rejects(
      () =>
        runYachiyoCli(
          [
            'agent',
            'add',
            '--payload',
            JSON.stringify({ name: 'No Command Agent' }),
            '--settings',
            settingsPath
          ],
          {
            stdout: {
              write() {
                return true
              }
            }
          }
        ),
      /command is required/
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('agent show - returns agent by id', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-cli-agent-'))
  const settingsPath = join(root, 'config.toml')

  try {
    const run = makeRunAgentCommand(settingsPath)
    const result = (await run(['agent', 'show', 'claude-code-default'])) as {
      id: string
      name: string
    }
    assert.equal(result.id, 'claude-code-default')
    assert.equal(result.name, 'Claude Code')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('agent show - returns agent by name', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-cli-agent-'))
  const settingsPath = join(root, 'config.toml')

  try {
    const run = makeRunAgentCommand(settingsPath)
    const result = (await run(['agent', 'show', 'Claude Code'])) as { id: string }
    assert.equal(result.id, 'claude-code-default')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('agent show - unknown agent throws', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-cli-agent-'))
  const settingsPath = join(root, 'config.toml')

  try {
    await assert.rejects(
      () =>
        runYachiyoCli(['agent', 'show', 'does-not-exist', '--settings', settingsPath], {
          stdout: {
            write() {
              return true
            }
          }
        }),
      /Unknown agent/
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('agent update - patches fields and preserves id', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-cli-agent-'))
  const settingsPath = join(root, 'config.toml')

  try {
    const run = makeRunAgentCommand(settingsPath)
    const result = (await run([
      'agent',
      'update',
      'claude-code-default',
      '--payload',
      JSON.stringify({
        description: 'Updated description',
        args: ['-y', '@zed-industries/claude-agent-acp', '--verbose']
      })
    ])) as { id: string; description: string; args: string[] }
    assert.equal(result.id, 'claude-code-default', 'id must not change on update')
    assert.equal(result.description, 'Updated description')
    assert.deepEqual(result.args, ['-y', '@zed-industries/claude-agent-acp', '--verbose'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('agent update - unknown agent throws', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-cli-agent-'))
  const settingsPath = join(root, 'config.toml')

  try {
    await assert.rejects(
      () =>
        runYachiyoCli(
          ['agent', 'update', 'no-such-agent', '--payload', '{}', '--settings', settingsPath],
          {
            stdout: {
              write() {
                return true
              }
            }
          }
        ),
      /Unknown agent/
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('agent remove - removes agent by id', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-cli-agent-'))
  const settingsPath = join(root, 'config.toml')

  try {
    const run = makeRunAgentCommand(settingsPath)
    const result = (await run(['agent', 'remove', 'claude-code-default'])) as {
      removed: string
      agents: Array<{ id: string }>
    }
    assert.equal(result.removed, 'claude-code-default')
    assert.ok(
      result.agents.every((a) => a.id !== 'claude-code-default'),
      'removed agent must not appear in returned list'
    )

    // Verify persisted
    const list = (await run(['agent', 'list'])) as Array<{ id: string }>
    assert.ok(
      list.every((a) => a.id !== 'claude-code-default'),
      'removal persisted to disk'
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('agent remove - unknown agent throws', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-cli-agent-'))
  const settingsPath = join(root, 'config.toml')

  try {
    await assert.rejects(
      () =>
        runYachiyoCli(['agent', 'remove', 'ghost-agent', '--settings', settingsPath], {
          stdout: {
            write() {
              return true
            }
          }
        }),
      /Unknown agent/
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('agent disable - sets enabled=false', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-cli-agent-'))
  const settingsPath = join(root, 'config.toml')

  try {
    const run = makeRunAgentCommand(settingsPath)
    const result = (await run(['agent', 'disable', 'claude-code-default'])) as {
      id: string
      enabled: boolean
    }
    assert.equal(result.id, 'claude-code-default')
    assert.equal(result.enabled, false)

    // Verify persisted
    const shown = (await run(['agent', 'show', 'claude-code-default'])) as { enabled: boolean }
    assert.equal(shown.enabled, false, 'disabled state persisted to disk')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('agent enable - sets enabled=true after disable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-cli-agent-'))
  const settingsPath = join(root, 'config.toml')

  try {
    const run = makeRunAgentCommand(settingsPath)
    await run(['agent', 'disable', 'claude-code-default'])
    const result = (await run(['agent', 'enable', 'claude-code-default'])) as {
      id: string
      enabled: boolean
    }
    assert.equal(result.id, 'claude-code-default')
    assert.equal(result.enabled, true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Send (notification) tests
// ---------------------------------------------------------------------------

test('send notification - delivers notification via sendNotification', async () => {
  const sent: Array<{ title: string; body?: string }> = []
  let stdout = ''

  await runYachiyoCli(['send', 'notification', 'Build completed'], {
    stdout: {
      write(chunk) {
        stdout += String(chunk)
        return true
      }
    },
    sendNotification: async (_socketPath, payload) => {
      sent.push(payload)
    }
  })

  assert.equal(sent.length, 1)
  assert.equal(sent[0]?.title, 'Yachiyo')
  assert.equal(sent[0]?.body, 'Build completed')
  assert.ok(stdout.includes('Notification sent'))
})

test('send notification - custom title via --title flag', async () => {
  const sent: Array<{ title: string; body?: string }> = []

  await runYachiyoCli(['send', 'notification', 'Tests passed', '--title', 'CI Result'], {
    stdout: {
      write() {
        return true
      }
    },
    sendNotification: async (_socketPath, payload) => {
      sent.push(payload)
    }
  })

  assert.equal(sent.length, 1)
  assert.equal(sent[0]?.title, 'CI Result')
  assert.equal(sent[0]?.body, 'Tests passed')
})

test('send notification - missing message throws', async () => {
  await assert.rejects(
    () =>
      runYachiyoCli(['send', 'notification'], {
        stdout: {
          write() {
            return true
          }
        },
        sendNotification: async () => {}
      }),
    /Message is required/
  )
})

test('send notification - propagates connection error', async () => {
  await assert.rejects(
    () =>
      runYachiyoCli(['send', 'notification', 'hello'], {
        stdout: {
          write() {
            return true
          }
        },
        sendNotification: async () => {
          throw new Error('Yachiyo app is not running. Start the app first to send notifications.')
        }
      }),
    /not running/
  )
})

test('send channel - delivers message via sendChannel', async () => {
  const calls: Array<{ type: string; id: string; message: string }> = []
  let stdout = ''

  await runYachiyoCli(['send', 'channel', 'user-abc', 'Hello from CLI'], {
    stdout: {
      write(chunk) {
        stdout += String(chunk)
        return true
      }
    },
    sendChannel: async (_socketPath, payload) => {
      calls.push(payload)
    }
  })

  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.type, 'send-channel')
  assert.equal(calls[0]?.id, 'user-abc')
  assert.equal(calls[0]?.message, 'Hello from CLI')
  assert.ok(stdout.includes('Message sent'))
})

test('send channel - missing id throws', async () => {
  await assert.rejects(
    () =>
      runYachiyoCli(['send', 'channel'], {
        stdout: {
          write() {
            return true
          }
        },
        sendChannel: async () => {}
      }),
    /Channel user or group ID is required/
  )
})

test('send channel - missing message throws', async () => {
  await assert.rejects(
    () =>
      runYachiyoCli(['send', 'channel', 'user-abc'], {
        stdout: {
          write() {
            return true
          }
        },
        sendChannel: async () => {}
      }),
    /Message is required/
  )
})

test('send channel - propagates connection error', async () => {
  await assert.rejects(
    () =>
      runYachiyoCli(['send', 'channel', 'user-abc', 'hi'], {
        stdout: {
          write() {
            return true
          }
        },
        sendChannel: async () => {
          throw new Error('Yachiyo app is not running. Start the app first.')
        }
      }),
    /not running/
  )
})

test('send - unknown subcommand throws', async () => {
  await assert.rejects(
    () =>
      runYachiyoCli(['send', 'foobar'], {
        stdout: {
          write() {
            return true
          }
        }
      }),
    /Unknown send subcommand.*Expected: notification, channel/
  )
})

test('agent enable - unknown agent throws', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-cli-agent-'))
  const settingsPath = join(root, 'config.toml')

  try {
    await assert.rejects(
      () =>
        runYachiyoCli(['agent', 'enable', 'phantom', '--settings', settingsPath], {
          stdout: {
            write() {
              return true
            }
          }
        }),
      /Unknown agent/
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
