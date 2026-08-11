import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { extractSuccessfulGroupMessageText } from '../../runtime/context/groupProbeContextLayers.ts'
import type { ModelMessage } from '../../runtime/models/types.ts'
import {
  buildClaudeCodeProbeCommand,
  parseClaudeCodeProbeDecision,
  runClaudeCodeGroupProbe
} from './groupProbeClaudeCode.ts'

const posixTest = process.platform === 'win32' ? test.skip : test

test('buildClaudeCodeProbeCommand uses claude print mode with optional model', () => {
  assert.deepEqual(buildClaudeCodeProbeCommand({ model: 'sonnet' }), {
    command: 'claude',
    args: [
      '-p',
      '--no-session-persistence',
      '--safe-mode',
      '--tools',
      '',
      '--disallowedTools',
      'mcp__*',
      '--output-format',
      'text',
      '--model',
      'sonnet'
    ]
  })

  assert.deepEqual(buildClaudeCodeProbeCommand({}), {
    command: 'claude',
    args: [
      '-p',
      '--no-session-persistence',
      '--safe-mode',
      '--tools',
      '',
      '--disallowedTools',
      'mcp__*',
      '--output-format',
      'text'
    ]
  })
})

test('parseClaudeCodeProbeDecision accepts bare and fenced JSON decisions', () => {
  assert.deepEqual(parseClaudeCodeProbeDecision('{"action":"silent"}'), { action: 'silent' })
  assert.deepEqual(
    parseClaudeCodeProbeDecision('```json\n{"action":"send","message":"来点有用的"}\n```'),
    {
      action: 'send',
      message: '来点有用的'
    }
  )
})

test('parseClaudeCodeProbeDecision preserves the exact visible message', () => {
  const message = `  ：先说第一行
}再说第二行  `

  assert.deepEqual(parseClaudeCodeProbeDecision(JSON.stringify({ action: 'send', message })), {
    action: 'send',
    message
  })
})

test('runClaudeCodeGroupProbe calls claude -p and records sent messages for replay', async () => {
  const messages: ModelMessage[] = [{ role: 'user', content: '<msg from="Alice">ping</msg>' }]
  const result = await runClaudeCodeGroupProbe({
    messages,
    workspacePath: '/tmp/yachiyo-group',
    providerName: 'Claude Code',
    model: 'sonnet',
    runCommand: async (input) => {
      assert.equal(input.command, 'claude')
      assert.deepEqual(input.args.slice(0, 9), [
        '-p',
        '--no-session-persistence',
        '--safe-mode',
        '--tools',
        '',
        '--disallowedTools',
        'mcp__*',
        '--output-format',
        'text'
      ])
      assert.deepEqual(input.args.slice(9), ['--model', 'sonnet'])
      assert.equal(input.cwd, '/tmp/yachiyo-group')
      assert.match(input.stdin, /<msg from="Alice">ping<\/msg>/)
      return '{"action":"send","message":"短一点"}'
    }
  })

  assert.equal(result.status, 'success')
  assert.equal(result.auxiliaryResult.settings.providerName, 'Claude Code')
  assert.equal(result.auxiliaryResult.settings.model, 'sonnet')
  assert.equal(result.decision.action, 'send')
  assert.equal(result.auxiliaryResult.usage, undefined)
  assert.equal(
    extractSuccessfulGroupMessageText(result.auxiliaryResult.responseMessages as ModelMessage[]),
    '短一点'
  )
})

test('runClaudeCodeGroupProbe preserves command runner failures', async () => {
  const result = await runClaudeCodeGroupProbe({
    messages: [{ role: 'user', content: 'ping' }],
    workspacePath: '/tmp/yachiyo-group',
    runCommand: async () => {
      throw new Error('unsupported flag')
    }
  })

  assert.equal(result.status, 'failed')
  assert.equal(result.error, 'unsupported flag')
})

posixTest('runClaudeCodeGroupProbe handles exit before stdin is consumed', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'yachiyo-claude-epipe-'))
  const binDir = join(tempDir, 'bin')
  await mkdir(binDir)
  const claudePath = join(binDir, 'claude')
  await writeFile(claudePath, '#!/bin/sh\necho "unsupported flag" >&2\nexit 2\n')
  await chmod(claudePath, 0o755)

  const originalPath = process.env.PATH
  process.env.PATH = `${binDir}:${originalPath ?? ''}`
  try {
    const result = await runClaudeCodeGroupProbe({
      messages: [{ role: 'user', content: 'x'.repeat(2 * 1024 * 1024) }],
      workspacePath: tempDir,
      model: 'sonnet'
    })

    assert.equal(result.status, 'failed')
    assert.equal(result.error, 'unsupported flag')
  } finally {
    process.env.PATH = originalPath
    await rm(tempDir, { recursive: true, force: true })
  }
})
