import assert from 'node:assert/strict'
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { buildBashCommand } from '../../runtime/shell/shellRuntime.ts'
import type { ProcessJobResult, StartProcessJobInput } from './processBroker.ts'
import { NodeProcessBrokerTestAdapter } from './nodeProcessBroker.testSupport.ts'

const inheritedOnlyKey = 'YACHIYO_PROCESS_BROKER_INHERITED_ONLY'

function explicitTestEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: process.env['PATH'],
    SystemRoot: process.env['SystemRoot'],
    WINDIR: process.env['WINDIR'],
    ComSpec: process.env['ComSpec'],
    YACHIYO_PROCESS_BROKER_SENTINEL: 'requested-value'
  }
}

async function collectJobOutput(
  broker: NodeProcessBrokerTestAdapter,
  input: StartProcessJobInput
): Promise<{ stdout: string; stderr: string; result: ProcessJobResult }> {
  const job = await broker.startJob(input)
  let stdout = ''
  let stderr = ''
  job.onOutput((batch) => {
    for (const chunk of batch.chunks) {
      if (chunk.stream === 'stdout') stdout += chunk.text
      else stderr += chunk.text
    }
  })
  const result = await job.wait()
  return { stdout, stderr, result }
}

test('direct jobs preserve literal argv, cwd, environment, and output streams', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-direct-process-'))
  const cwd = join(root, 'working directory & literal')
  const broker = new NodeProcessBrokerTestAdapter()
  const previousInheritedOnly = process.env[inheritedOnlyKey]
  process.env[inheritedOnlyKey] = 'must-not-leak'
  try {
    await mkdir(cwd, { recursive: true })
    const expectedCwd = await realpath(cwd)
    const args = ['space value', 'quote"value', '*', '$()', '&', '$(touch should-not-run)']
    const script = [
      'const payload = { argv: process.argv.slice(1), cwd: process.cwd(), sentinel: process.env.YACHIYO_PROCESS_BROKER_SENTINEL, inheritedOnly: process.env.YACHIYO_PROCESS_BROKER_INHERITED_ONLY ?? null }',
      "process.stdout.write(JSON.stringify(payload) + '\\n')",
      "process.stderr.write('separate-stderr\\n')"
    ].join(';')
    const { stdout, stderr, result } = await collectJobOutput(broker, {
      id: 'direct-literals',
      executable: process.execPath,
      args: ['-e', script, ...args],
      cwd,
      env: explicitTestEnvironment(),
      logPath: join(root, 'direct.log'),
      timeoutSeconds: 5,
      keepRunningOnTimeout: false,
      retainLog: false,
      spillThresholdChars: 20_000
    })

    assert.equal(result.exitCode, 0)
    assert.equal(result.timedOut, false)
    assert.deepEqual(JSON.parse(stdout), {
      argv: args,
      cwd: expectedCwd,
      sentinel: 'requested-value',
      inheritedOnly: null
    })
    assert.equal(stderr, 'separate-stderr\n')
  } finally {
    if (previousInheritedOnly === undefined) delete process.env[inheritedOnlyKey]
    else process.env[inheritedOnlyKey] = previousInheritedOnly
    await broker.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('command jobs retain shell execution compatibility', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-command-process-'))
  const broker = new NodeProcessBrokerTestAdapter()

  try {
    const command = buildBashCommand(process.execPath.replaceAll('\\', '/'), [
      '-e',
      "process.stdout.write('command-branch\\n')"
    ])
    const { stdout, result } = await collectJobOutput(broker, {
      id: 'command-compatibility',
      command,
      cwd: root,
      env: process.env,
      logPath: join(root, 'command.log'),
      timeoutSeconds: 5,
      keepRunningOnTimeout: false,
      retainLog: false,
      spillThresholdChars: 20_000
    })

    assert.equal(result.exitCode, 0)
    assert.equal(stdout, 'command-branch\n')
  } finally {
    await broker.close()
    await rm(root, { recursive: true, force: true })
  }
})

// The adapter's timeout is tied to a real child-process clock; fake JavaScript
// timers cannot advance the spawned process or OS termination lifecycle.
test('direct job timeout and cancellation each settle once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-direct-settlement-'))
  const broker = new NodeProcessBrokerTestAdapter()
  const common = {
    executable: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1_000)'],
    cwd: root,
    env: explicitTestEnvironment(),
    keepRunningOnTimeout: false,
    retainLog: false,
    spillThresholdChars: 20_000
  } as const

  try {
    const timed = await broker.startJob({
      ...common,
      id: 'direct-timeout',
      logPath: join(root, 'timeout.log'),
      timeoutSeconds: 0.05
    })
    const timeoutResult = await timed.wait()
    assert.equal(timeoutResult.timedOut, true)
    assert.deepEqual(await timed.wait(), timeoutResult)

    const cancelled = await broker.startJob({
      ...common,
      id: 'direct-cancel',
      logPath: join(root, 'cancel.log'),
      timeoutSeconds: 5
    })
    cancelled.cancel()
    const cancelResult = await cancelled.wait()
    assert.equal(cancelResult.cancelled, true)
    assert.deepEqual(await cancelled.wait(), cancelResult)
  } finally {
    await broker.close()
    await rm(root, { recursive: true, force: true })
  }
})
