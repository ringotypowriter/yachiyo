import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptions } from 'node:child_process'
import assert from 'node:assert/strict'
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import test from 'node:test'

import { buildBashCommand } from '../../runtime/shell/shellRuntime.ts'
import { NativeProcessBroker, resolveProcessHostBinary } from './nativeProcessBroker.ts'
import { PROCESS_HOST_PROTOCOL_VERSION } from './processHostProtocol.generated.ts'
import { runBashTool } from '../../tools/agentTools/bashTool.ts'
import { BackgroundBashManager } from '../../app/domain/background/backgroundBashManager.ts'
const nodeExecutable = process.platform === 'win32' ? 'node.exe' : 'node'

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test('native direct jobs preserve literal argv, cwd, environment, and output streams', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-native-direct-process-'))
  const cwd = join(root, 'working directory & literal')
  const broker = new NativeProcessBroker()
  const inheritedOnlyKey = 'YACHIYO_NATIVE_PROCESS_BROKER_INHERITED_ONLY'
  const previousInheritedOnly = process.env[inheritedOnlyKey]
  process.env[inheritedOnlyKey] = 'must-not-leak'
  try {
    await mkdir(cwd, { recursive: true })
    await broker.start()
    const expectedCwd = await realpath(cwd)
    const args = [
      'space value',
      'quote"value',
      '*',
      '$()',
      '&',
      '$(touch should-not-run)',
      '"; process.exit(97); "'
    ]
    const script = [
      'const payload = { argv: process.argv.slice(1), cwd: process.cwd(), sentinel: process.env.YACHIYO_NATIVE_PROCESS_BROKER_SENTINEL, inheritedOnly: process.env.YACHIYO_NATIVE_PROCESS_BROKER_INHERITED_ONLY ?? null }',
      "process.stdout.write(JSON.stringify(payload) + '\\n')",
      "process.stderr.write('separate-stderr\\n')"
    ].join(';')
    const job = await broker.startJob({
      id: 'native-direct-literals',
      executable: nodeExecutable,
      args: ['-e', script, ...args],
      cwd,
      env: {
        PATH: process.env['PATH'] ?? process.env['Path'],
        SystemRoot: process.env['SystemRoot'],
        WINDIR: process.env['WINDIR'],
        ComSpec: process.env['ComSpec'],
        PATHEXT: process.env['PATHEXT'],
        TEMP: process.env['TEMP'],
        TMP: process.env['TMP'],
        YACHIYO_NATIVE_PROCESS_BROKER_SENTINEL: 'requested-value'
      },
      logPath: join(root, 'direct.log'),
      timeoutSeconds: 5,
      keepRunningOnTimeout: false,
      retainLog: false,
      spillThresholdChars: 20_000
    })
    let stdout = ''
    let stderr = ''
    job.onOutput((batch) => {
      for (const chunk of batch.chunks) {
        if (chunk.stream === 'stdout') stdout += chunk.text
        else stderr += chunk.text
      }
    })
    const result = await job.wait()

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

test(
  'native process host survives SIGINT until its parent requests shutdown',
  {
    skip:
      process.platform === 'win32' ? 'SIGINT delivery is not process-addressable on Windows' : false
  },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'yachiyo-native-process-host-sigint-'))
    let processHostPid: number | undefined
    let processHostStarts = 0
    const spawnProcess = ((
      command: string,
      args: readonly string[],
      options: SpawnOptions
    ): ChildProcessWithoutNullStreams => {
      const child = spawn(command, args, options) as ChildProcessWithoutNullStreams
      processHostPid = child.pid
      processHostStarts += 1
      return child
    }) as typeof spawn
    const broker = new NativeProcessBroker({ spawnProcess })

    try {
      await broker.start()
      assert.ok(processHostPid)

      process.kill(processHostPid, 'SIGINT')
      await sleep(100)

      const job = await broker.startJob({
        id: 'native-process-host-after-sigint',
        executable: nodeExecutable,
        args: ['-e', "process.stdout.write('alive\\n')"],
        cwd: root,
        env: process.env,
        logPath: join(root, 'after-sigint.log'),
        timeoutSeconds: 5,
        keepRunningOnTimeout: false,
        retainLog: false,
        spillThresholdChars: 20_000
      })
      const result = await job.wait()

      assert.equal(result.exitCode, 0)
      assert.equal(processHostStarts, 1)
    } finally {
      await broker.close()
      await rm(root, { recursive: true, force: true })
    }
  }
)
test('native broker closes when its control pipe breaks during shutdown', async () => {
  let processHost: ChildProcessWithoutNullStreams | undefined
  const readyMessage = `${JSON.stringify({
    type: 'ready',
    protocolVersion: PROCESS_HOST_PROTOCOL_VERSION
  })}\n`
  const spawnProcess = ((
    _command: string,
    _args: readonly string[],
    options: SpawnOptions
  ): ChildProcessWithoutNullStreams => {
    const child = spawn(
      nodeExecutable,
      ['-e', `process.stdout.write(${JSON.stringify(readyMessage)}); setInterval(() => {}, 1_000)`],
      options
    ) as ChildProcessWithoutNullStreams
    processHost = child
    return child
  }) as typeof spawn
  const broker = new NativeProcessBroker({ spawnProcess })

  try {
    await broker.start()
    assert.ok(processHost)

    processHost.stdin.destroy(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))

    await assert.doesNotReject(() => broker.close())
    assert.ok(processHost.exitCode !== null || processHost.signalCode !== null)
  } finally {
    if (processHost && processHost.exitCode === null && processHost.signalCode === null) {
      const exited = Promise.withResolvers<void>()
      processHost.once('exit', () => exited.resolve())
      processHost.kill('SIGKILL')
      await exited.promise
    }
    await broker.close().catch(() => undefined)
  }
})

// The sidecar timeout and OS process termination use external clocks that
// JavaScript fake timers cannot advance.
test('native direct timeout and cancellation each settle once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-native-direct-settlement-'))
  const broker = new NativeProcessBroker()
  const common = {
    executable: nodeExecutable,
    args: ['-e', 'setInterval(() => {}, 1_000)'],
    cwd: root,
    env: process.env,
    keepRunningOnTimeout: false,
    retainLog: false,
    spillThresholdChars: 20_000
  } as const

  try {
    await broker.start()
    const timed = await broker.startJob({
      ...common,
      id: 'native-direct-timeout',
      logPath: join(root, 'timeout.log'),
      timeoutSeconds: 0.05
    })
    const timeoutOutcome = await timed.waitForOutcome()
    const timeoutResult = await timed.wait()
    assert.deepEqual(timeoutOutcome, { kind: 'timed-out' })
    assert.equal(timeoutResult.timedOut, true)
    assert.deepEqual(await timed.waitForOutcome(), timeoutOutcome)
    assert.deepEqual(await timed.wait(), timeoutResult)

    const cancelled = await broker.startJob({
      ...common,
      id: 'native-direct-cancel',
      logPath: join(root, 'cancel.log'),
      timeoutSeconds: 5
    })
    cancelled.cancel()
    const cancelOutcome = await cancelled.waitForOutcome()
    const cancelResult = await cancelled.wait()
    assert.equal(cancelOutcome.kind, 'exited')
    assert.equal(cancelResult.cancelled, true)
    assert.deepEqual(await cancelled.waitForOutcome(), cancelOutcome)
    assert.deepEqual(await cancelled.wait(), cancelResult)
  } finally {
    await broker.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('resident process host executes jobs, batches both streams, and removes inline-only logs', async () => {
  const workspacePath = await mkdtemp(join(tmpdir(), 'yachiyo-process-host-small-'))
  const broker = new NativeProcessBroker()
  try {
    await broker.start()
    const logPath = join(workspacePath, 'small.log')
    const command = buildBashCommand(nodeExecutable, [
      '-e',
      "process.stdout.write('stdout-line\\n'); process.stderr.write('stderr-line\\n')"
    ])
    const job = await broker.startJob({
      id: 'small-job',
      command,
      cwd: workspacePath,
      env: process.env,
      logPath,
      timeoutSeconds: 5,
      keepRunningOnTimeout: false,
      retainLog: false,
      spillThresholdChars: 20_000
    })
    const result = await job.wait()
    const chunks: string[] = []
    job.onOutput((batch) => {
      for (const chunk of batch.chunks) chunks.push(`${chunk.stream}:${chunk.text}`)
    })
    assert.equal(result.exitCode, 0)
    assert.equal(result.timedOut, false)
    assert.equal(result.cancelled, false)
    assert.equal(result.spilled, false)
    assert.match(chunks.join(''), /stdout:stdout-line\n/u)
    assert.match(chunks.join(''), /stderr:stderr-line\n/u)
    await assert.rejects(readFile(logPath), { code: 'ENOENT' })
  } finally {
    await broker.close()
    await rm(workspacePath, { recursive: true, force: true })
  }
})
test('Bash spill threshold uses the same UTF-16 metric as inline truncation', async () => {
  const workspacePath = await mkdtemp(join(tmpdir(), 'yachiyo-process-host-bash-tool-'))
  const broker = new NativeProcessBroker()
  try {
    await broker.start()
    const command = buildBashCommand(nodeExecutable, [
      '-e',
      "process.stdout.write('😀'.repeat(15_000))"
    ])
    const result = await runBashTool(
      {
        command,
        description: 'emit astral Unicode output',
        timeout: 5,
        background: false
      },
      { workspacePath, processBroker: broker }
    )

    assert.equal(result.error, undefined)
    assert.equal(result.details.exitCode, 0)
    assert.equal(result.details.truncated, true)
    assert.equal(await readFile(result.details.outputFilePath!, 'utf8'), '😀'.repeat(15_000))
  } finally {
    await broker.close()
    await rm(workspacePath, { recursive: true, force: true })
  }
})

test('late output subscribers receive a bounded batch with explicit truncation', async () => {
  const workspacePath = await mkdtemp(join(tmpdir(), 'yachiyo-process-host-late-output-'))
  const broker = new NativeProcessBroker()
  try {
    await broker.start()
    const logPath = join(workspacePath, 'late-output.log')
    const command = buildBashCommand(nodeExecutable, [
      '-e',
      "process.stdout.write('x'.repeat(200_000))"
    ])
    const job = await broker.startJob({
      id: 'late-output-job',
      command,
      cwd: workspacePath,
      env: process.env,
      logPath,
      timeoutSeconds: 5,
      keepRunningOnTimeout: false,
      retainLog: true,
      spillThresholdChars: 20_000
    })

    const result = await job.wait()
    let bufferedBytes = 0
    let truncated = false
    job.onOutput((batch) => {
      truncated ||= batch.truncated
      for (const chunk of batch.chunks) bufferedBytes += Buffer.byteLength(chunk.text)
    })

    assert.equal(result.exitCode, 0)
    assert.equal(truncated, true)
    assert.ok(bufferedBytes <= 64 * 1024)
    assert.equal((await readFile(logPath, 'utf8')).length, 200_000)
  } finally {
    await broker.close()
    await rm(workspacePath, { recursive: true, force: true })
  }
})

// The child process and native flush interval use external clocks that JavaScript
// fake timers cannot advance.
test('running jobs expose flushed partial logs after an output batch', async () => {
  const workspacePath = await mkdtemp(join(tmpdir(), 'yachiyo-process-host-live-log-'))
  const broker = new NativeProcessBroker()
  try {
    await broker.start()
    const logPath = join(workspacePath, 'live.log')
    const command = buildBashCommand(nodeExecutable, [
      '-e',
      "process.stdout.write('partial\\n'); setTimeout(() => {}, 30_000)"
    ])
    const job = await broker.startJob({
      id: 'live-log-job',
      command,
      cwd: workspacePath,
      env: process.env,
      logPath,
      timeoutSeconds: 60,
      keepRunningOnTimeout: false,
      retainLog: true,
      spillThresholdChars: 20_000
    })
    const output = Promise.withResolvers<void>()
    job.onOutput((batch) => {
      if (batch.chunks.some((chunk) => chunk.text.includes('partial\n'))) output.resolve()
    })

    await output.promise
    assert.equal(await readFile(logPath, 'utf8'), 'partial\n')
    job.cancel()
    await job.wait()
  } finally {
    await broker.close()
    await rm(workspacePath, { recursive: true, force: true })
  }
})

// This transfer is triggered by the Rust host's real timeout, which JavaScript
// fake timers cannot advance across the process boundary.
test('foreground timeout transfers the same native job into background ownership', async () => {
  const workspacePath = await mkdtemp(join(tmpdir(), 'yachiyo-process-host-adopt-'))
  const broker = new NativeProcessBroker()
  const manager = new BackgroundBashManager(broker)
  try {
    await broker.start()
    const completed = Promise.withResolvers<{ exitCode: number | undefined; logPath: string }>()
    manager.setCompletionHandler((result) => {
      completed.resolve({ exitCode: result.exitCode, logPath: result.logPath })
    })
    const command = buildBashCommand(nodeExecutable, [
      '-e',
      "process.stdout.write('before\\n'); setTimeout(() => process.stdout.write('after\\n'), 200)"
    ])
    const result = await runBashTool(
      {
        command,
        description: 'exercise timeout adoption',
        timeout: 0.05,
        background: false
      },
      {
        workspacePath,
        processBroker: broker,
        onBackgroundBashAdopted: async (task) => {
          await manager.adoptTask({ ...task, threadId: 'thread-adopt' })
        }
      },
      { toolCallId: 'adopt-job' }
    )

    assert.equal(result.details.background, true)
    assert.equal(result.details.liftedAfterTimeout, true)
    const background = await completed.promise
    assert.equal(background.exitCode, 0)
    assert.equal(await readFile(background.logPath, 'utf8'), 'before\nafter\n')
  } finally {
    await manager.close()
    await broker.close()
    await rm(workspacePath, { recursive: true, force: true })
  }
})

// Integration coverage intentionally uses the sidecar's real monotonic clock;
// JavaScript fake timers cannot advance Rust process deadlines.
test('timed-out foreground jobs stay native-owned and retain a complete background log', async () => {
  const workspacePath = await mkdtemp(join(tmpdir(), 'yachiyo-process-host-timeout-'))
  const broker = new NativeProcessBroker()
  try {
    await broker.start()
    const logPath = join(workspacePath, 'timeout.log')
    const command = buildBashCommand(nodeExecutable, [
      '-e',
      "process.stdout.write('before\\n'); setTimeout(() => process.stdout.write('after\\n'), 200)"
    ])
    const job = await broker.startJob({
      id: 'timeout-job',
      command,
      cwd: workspacePath,
      env: process.env,
      logPath,
      timeoutSeconds: 0.05,
      keepRunningOnTimeout: true,
      retainLog: false,
      spillThresholdChars: 20_000
    })

    assert.deepEqual(await job.waitForOutcome(), { kind: 'timed-out' })
    const result = await job.wait()
    assert.equal(result.exitCode, 0)
    assert.equal(result.timedOut, true)
    assert.equal(result.cancelled, false)
    assert.equal(result.spilled, true)
    assert.equal(await readFile(logPath, 'utf8'), 'before\nafter\n')
  } finally {
    await broker.close()
    await rm(workspacePath, { recursive: true, force: true })
  }
})

test('native cancellation terminates shell descendants as one process group', async () => {
  const workspacePath = await mkdtemp(join(tmpdir(), 'yachiyo-process-host-cancel-'))
  const broker = new NativeProcessBroker()
  let descendantPid = 0
  try {
    await broker.start()
    const pidPath = join(workspacePath, 'descendant.pid')
    const command = buildBashCommand(nodeExecutable, [
      '-e',
      [
        "const { spawn } = require('node:child_process')",
        "const { writeFileSync } = require('node:fs')",
        "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1_000)'], { stdio: 'ignore' })",
        "writeFileSync('descendant.pid', String(child.pid))",
        "child.on('exit', () => process.exit(0))",
        'setInterval(() => {}, 1_000)'
      ].join('; ')
    ])
    const job = await broker.startJob({
      id: 'cancel-job',
      command,
      cwd: workspacePath,
      env: process.env,
      logPath: join(workspacePath, 'cancel.log'),
      timeoutSeconds: 30,
      keepRunningOnTimeout: false,
      retainLog: true,
      spillThresholdChars: 20_000
    })

    // Descendant creation and reaping are external OS state, so fake JavaScript
    // timers cannot drive these waits deterministically.
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      try {
        descendantPid = Number.parseInt((await readFile(pidPath, 'utf8')).trim(), 10)
      } catch {
        // The shell has not written the descendant pid yet.
      }
      if (Number.isInteger(descendantPid) && descendantPid > 0) break
      await sleep(20)
    }
    assert.ok(descendantPid > 0, 'expected the command to record its descendant pid')
    assert.equal(processExists(descendantPid), true)

    job.cancel()
    const result = await job.wait()
    assert.equal(result.cancelled, true)
    const killDeadline = Date.now() + 3_000
    while (Date.now() < killDeadline && processExists(descendantPid)) await sleep(20)
    assert.equal(processExists(descendantPid), false)
  } finally {
    if (descendantPid > 0 && processExists(descendantPid)) process.kill(descendantPid, 'SIGKILL')
    await broker.close()
    await rm(workspacePath, { recursive: true, force: true })
  }
})

test('broker can restart after an executable spawn emits error then close', async () => {
  const workspacePath = await mkdtemp(join(tmpdir(), 'yachiyo-process-host-restart-'))
  const sourceBinary = resolveProcessHostBinary()
  const stagedBinary = join(
    workspacePath,
    process.platform === 'win32' ? 'process-host.exe' : 'process-host'
  )
  const broker = new NativeProcessBroker({ binaryPath: stagedBinary })
  let running = false
  try {
    await assert.rejects(broker.start())
    await copyFile(sourceBinary, stagedBinary)
    if (process.platform !== 'win32') await chmod(stagedBinary, 0o755)
    await broker.start()
    running = true
  } finally {
    if (running) await broker.close()
    await rm(workspacePath, { recursive: true, force: true })
  }
})
