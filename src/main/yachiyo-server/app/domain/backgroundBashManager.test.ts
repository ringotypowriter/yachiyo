import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'

import { BackgroundBashManager, type BackgroundBashTaskResult } from './backgroundBashManager.ts'

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
})
