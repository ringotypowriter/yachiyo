import { spawn } from 'node:child_process'
import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { join, dirname } from 'node:path'
import { mkdir, mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'

import {
  BackgroundBashManager,
  type BackgroundBashLogAppend,
  type BackgroundBashTaskResult
} from './backgroundBashManager.ts'

async function createTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'bg-bash-test-'))
}

describe('BackgroundBashManager', () => {
  it('runs a command and calls completion handler with exit code', async () => {
    const tempDir = await createTempDir()
    try {
      const manager = new BackgroundBashManager()
      const completed = new Promise<BackgroundBashTaskResult>((resolve) => {
        manager.setCompletionHandler(resolve)
      })

      const logPath = join(tempDir, 'tool-output', 'test-task.log')
      await manager.startTask({
        taskId: 'test-task',
        command: 'echo hello && echo world',
        cwd: tempDir,
        logPath,
        threadId: 'thread-1',
        toolCallId: 'tc-1'
      })

      const result = await completed
      assert.equal(result.taskId, 'test-task')
      assert.equal(result.exitCode, 0)
      assert.equal(result.threadId, 'thread-1')
      assert.equal(result.toolCallId, 'tc-1')
      assert.equal(result.command, 'echo hello && echo world')
      assert.equal(result.logPath, logPath)

      const log = await readFile(logPath, 'utf8')
      assert.ok(log.includes('hello'))
      assert.ok(log.includes('world'))
      assert.equal(manager.activeCount, 0)
    } finally {
      await rm(tempDir, { recursive: true })
    }
  })

  it('reports non-zero exit code for failing commands', async () => {
    const tempDir = await createTempDir()
    try {
      const manager = new BackgroundBashManager()
      const completed = new Promise<BackgroundBashTaskResult>((resolve) => {
        manager.setCompletionHandler(resolve)
      })

      await manager.startTask({
        taskId: 'fail-task',
        command: 'exit 42',
        cwd: tempDir,
        logPath: join(tempDir, 'tool-output', 'fail.log'),
        threadId: 'thread-2'
      })

      const result = await completed
      assert.equal(result.exitCode, 42)
      assert.equal(result.taskId, 'fail-task')
    } finally {
      await rm(tempDir, { recursive: true })
    }
  })

  it('captures stderr in the log file', async () => {
    const tempDir = await createTempDir()
    try {
      const manager = new BackgroundBashManager()
      const completed = new Promise<BackgroundBashTaskResult>((resolve) => {
        manager.setCompletionHandler(resolve)
      })

      const logPath = join(tempDir, 'tool-output', 'stderr.log')
      await manager.startTask({
        taskId: 'stderr-task',
        command: 'echo err-output >&2',
        cwd: tempDir,
        logPath,
        threadId: 'thread-3'
      })

      await completed
      const log = await readFile(logPath, 'utf8')
      assert.ok(log.includes('err-output'))
    } finally {
      await rm(tempDir, { recursive: true })
    }
  })

  it('cancelTask kills the process', async () => {
    const tempDir = await createTempDir()
    try {
      const manager = new BackgroundBashManager()
      const completed = new Promise<BackgroundBashTaskResult>((resolve) => {
        manager.setCompletionHandler(resolve)
      })

      await manager.startTask({
        taskId: 'cancel-task',
        command: 'sleep 60',
        cwd: tempDir,
        logPath: join(tempDir, 'tool-output', 'cancel.log'),
        threadId: 'thread-4'
      })

      assert.equal(manager.activeCount, 1)
      const cancelled = manager.cancelTask('cancel-task')
      assert.ok(cancelled)

      const result = await completed
      assert.notEqual(result.exitCode, 0)
      assert.equal(manager.activeCount, 0)
    } finally {
      await rm(tempDir, { recursive: true })
    }
  })

  it('cancelTask returns false for unknown taskId', () => {
    const manager = new BackgroundBashManager()
    assert.equal(manager.cancelTask('nonexistent'), false)
  })

  it('getTask returns task info for active task', async () => {
    const tempDir = await createTempDir()
    try {
      const manager = new BackgroundBashManager()
      const completed = new Promise<BackgroundBashTaskResult>((resolve) => {
        manager.setCompletionHandler(resolve)
      })

      await manager.startTask({
        taskId: 'info-task',
        command: 'sleep 60',
        cwd: tempDir,
        logPath: join(tempDir, 'tool-output', 'info.log'),
        threadId: 'thread-5'
      })

      const info = manager.getTask('info-task')
      assert.ok(info)
      assert.equal(info.taskId, 'info-task')
      assert.equal(info.threadId, 'thread-5')
      assert.equal(info.command, 'sleep 60')

      assert.equal(manager.getTask('nonexistent'), undefined)

      manager.cancelTask('info-task')
      await completed
    } finally {
      await rm(tempDir, { recursive: true })
    }
  })

  it('close kills all active tasks', async () => {
    const tempDir = await createTempDir()
    try {
      const manager = new BackgroundBashManager()
      const handler = mock.fn<(result: BackgroundBashTaskResult) => void>()
      manager.setCompletionHandler(handler)

      await manager.startTask({
        taskId: 'close-1',
        command: 'sleep 60',
        cwd: tempDir,
        logPath: join(tempDir, 'tool-output', 'close1.log'),
        threadId: 'thread-6'
      })
      await manager.startTask({
        taskId: 'close-2',
        command: 'sleep 60',
        cwd: tempDir,
        logPath: join(tempDir, 'tool-output', 'close2.log'),
        threadId: 'thread-6'
      })

      assert.equal(manager.activeCount, 2)
      await manager.close()
      assert.equal(manager.activeCount, 0)
      assert.equal(handler.mock.callCount(), 2)
    } finally {
      await rm(tempDir, { recursive: true })
    }
  })

  it('streams log lines through the log-append handler', async () => {
    const tempDir = await createTempDir()
    try {
      const manager = new BackgroundBashManager()
      const collected: string[] = []
      manager.setLogAppendHandler((event: BackgroundBashLogAppend) => {
        for (const line of event.lines) collected.push(line)
      })
      const completed = new Promise<BackgroundBashTaskResult>((resolve) => {
        manager.setCompletionHandler(resolve)
      })

      await manager.startTask({
        taskId: 'log-task',
        command: 'printf "alpha\\nbeta\\ngamma\\n"',
        cwd: tempDir,
        logPath: join(tempDir, 'tool-output', 'log.log'),
        threadId: 'thread-log'
      })

      await completed
      // Allow any throttled flush to land.
      await new Promise((r) => setTimeout(r, 150))

      assert.deepEqual(
        collected.filter((l) => l.length > 0),
        ['alpha', 'beta', 'gamma']
      )
    } finally {
      await rm(tempDir, { recursive: true })
    }
  })

  it('listSnapshots returns running tasks and recently-completed entries', async () => {
    const tempDir = await createTempDir()
    try {
      const manager = new BackgroundBashManager()
      const completed = new Promise<BackgroundBashTaskResult>((resolve) => {
        manager.setCompletionHandler(resolve)
      })

      await manager.startTask({
        taskId: 'snap-running',
        command: 'sleep 30',
        cwd: tempDir,
        logPath: join(tempDir, 'tool-output', 'snap-running.log'),
        threadId: 'snap-thread'
      })

      await manager.startTask({
        taskId: 'snap-done',
        command: 'true',
        cwd: tempDir,
        logPath: join(tempDir, 'tool-output', 'snap-done.log'),
        threadId: 'snap-thread'
      })

      await completed

      const snaps = manager.listSnapshots('snap-thread')
      const byId = new Map(snaps.map((s) => [s.taskId, s]))
      assert.equal(byId.get('snap-running')?.status, 'running')
      assert.equal(byId.get('snap-done')?.status, 'completed')
      assert.equal(byId.get('snap-done')?.exitCode, 0)

      // Tasks for other threads must not leak.
      assert.equal(manager.listSnapshots('other-thread').length, 0)

      manager.cancelTask('snap-running')
      await manager.close()
    } finally {
      await rm(tempDir, { recursive: true })
    }
  })

  it('adoptTask preserves pre-timeout output already on disk and replays it as log lines', async () => {
    const tempDir = await createTempDir()
    try {
      const manager = new BackgroundBashManager()
      const collected: string[] = []
      manager.setLogAppendHandler((event: BackgroundBashLogAppend) => {
        for (const line of event.lines) collected.push(line)
      })
      const completed = new Promise<BackgroundBashTaskResult>((resolve) => {
        manager.setCompletionHandler(resolve)
      })

      // Simulate the foreground spill: log file already contains pre-timeout output.
      const logPath = join(tempDir, 'tool-output', 'adopt-disk.log')
      await mkdir(dirname(logPath), { recursive: true })
      const preTimeout = 'pre-1\npre-2\npre-3\n'
      await writeFile(logPath, preTimeout, 'utf8')

      // Spawn a child that will print one more line and then exit.
      const child = spawn('/bin/zsh', ['-lc', 'echo post-line'], {
        cwd: tempDir,
        stdio: ['ignore', 'pipe', 'pipe']
      })

      await manager.adoptTask({
        taskId: 'adopt-disk',
        command: 'echo post-line',
        cwd: tempDir,
        logPath,
        threadId: 'thread-adopt',
        child,
        initialOutput: preTimeout,
        initialOutputAlreadyOnDisk: true
      })

      await completed
      // Allow the throttled flush to land.
      await new Promise((r) => setTimeout(r, 200))

      const log = await readFile(logPath, 'utf8')
      // Pre-timeout bytes must still be there (append mode, not truncated).
      assert.ok(
        log.startsWith(preTimeout),
        `expected log to start with pre-timeout bytes, got: ${JSON.stringify(log)}`
      )
      assert.ok(log.includes('post-line'))

      // Renderer should have seen both pre-timeout and post-adoption lines.
      const nonEmpty = collected.filter((l) => l.length > 0)
      assert.deepEqual(nonEmpty, ['pre-1', 'pre-2', 'pre-3', 'post-line'])
    } finally {
      await rm(tempDir, { recursive: true })
    }
  })

  it('adoptTask writes initialOutput when not yet on disk and replays it as log lines', async () => {
    const tempDir = await createTempDir()
    try {
      const manager = new BackgroundBashManager()
      const collected: string[] = []
      manager.setLogAppendHandler((event: BackgroundBashLogAppend) => {
        for (const line of event.lines) collected.push(line)
      })
      const completed = new Promise<BackgroundBashTaskResult>((resolve) => {
        manager.setCompletionHandler(resolve)
      })

      const logPath = join(tempDir, 'tool-output', 'adopt-mem.log')
      const child = spawn('/bin/zsh', ['-lc', 'echo tail'], {
        cwd: tempDir,
        stdio: ['ignore', 'pipe', 'pipe']
      })

      await manager.adoptTask({
        taskId: 'adopt-mem',
        command: 'echo tail',
        cwd: tempDir,
        logPath,
        threadId: 'thread-adopt-mem',
        child,
        initialOutput: 'head-1\nhead-2\n',
        initialOutputAlreadyOnDisk: false
      })

      await completed
      await new Promise((r) => setTimeout(r, 200))

      const log = await readFile(logPath, 'utf8')
      assert.ok(log.startsWith('head-1\nhead-2\n'))
      assert.ok(log.includes('tail'))

      const nonEmpty = collected.filter((l) => l.length > 0)
      assert.deepEqual(nonEmpty, ['head-1', 'head-2', 'tail'])
    } finally {
      await rm(tempDir, { recursive: true })
    }
  })
})
