import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { runYachiyoCli } from './yachiyoCli.ts'
import {
  readSoulDocument,
  upsertDailySoulTrait,
  removeSoulTrait
} from '@yachiyo/runtime/runtime/profiles/soul'

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
