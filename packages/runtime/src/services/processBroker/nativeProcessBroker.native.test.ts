import assert from 'node:assert/strict'
import { chmod, copyFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import test from 'node:test'

import { buildBashCommand } from '../../runtime/shell/shellRuntime.ts'
import { NativeProcessBroker, resolveProcessHostBinary } from './nativeProcessBroker.ts'
import { runBashTool } from '../../tools/agentTools/bashTool.ts'
import { BackgroundBashManager } from '../../app/domain/background/backgroundBashManager.ts'
const nodeExecutable = process.execPath.replaceAll('\\', '/')

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

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
