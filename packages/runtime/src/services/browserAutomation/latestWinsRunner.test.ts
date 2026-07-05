import assert from 'node:assert/strict'
import test from 'node:test'

import { createLatestWinsRunner } from './latestWinsRunner.ts'

function createGatedTask(): {
  run: () => Promise<void>
  release: () => void
  starts: number[]
} {
  const starts: number[] = []
  const releases: Array<() => void> = []
  return {
    run: () =>
      new Promise<void>((resolve) => {
        starts.push(starts.length + 1)
        releases.push(resolve)
      }),
    release: () => {
      const resolve = releases.shift()
      if (!resolve) {
        throw new Error('no pending run to release')
      }
      resolve()
    },
    starts
  }
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

test('coalesces schedules issued while a run is in flight into one trailing run', async () => {
  const task = createGatedTask()
  const schedule = createLatestWinsRunner(task.run)

  schedule()
  schedule()
  schedule()
  schedule()
  assert.deepEqual(task.starts.length, 1)

  task.release()
  await settle()
  assert.equal(task.starts.length, 2)

  task.release()
  await settle()
  assert.equal(task.starts.length, 2)
})

test('runs immediately when idle', async () => {
  const task = createGatedTask()
  const schedule = createLatestWinsRunner(task.run)

  schedule()
  assert.equal(task.starts.length, 1)
  task.release()
  await settle()

  schedule()
  assert.equal(task.starts.length, 2)
  task.release()
  await settle()
  assert.equal(task.starts.length, 2)
})

test('a rejected run does not jam the scheduler', async () => {
  let attempts = 0
  const schedule = createLatestWinsRunner(async () => {
    attempts += 1
    if (attempts === 1) {
      throw new Error('page reloaded')
    }
  })

  schedule()
  await settle()
  schedule()
  await settle()

  assert.equal(attempts, 2)
})

test('a schedule racing the trailing-run handoff is not lost', async () => {
  const task = createGatedTask()
  const schedule = createLatestWinsRunner(task.run)

  schedule()
  schedule() // marks dirty → trailing run
  task.release()
  await settle()
  assert.equal(task.starts.length, 2)

  schedule() // arrives while trailing run is in flight
  task.release()
  await settle()
  assert.equal(task.starts.length, 3)
  task.release()
  await settle()
  assert.equal(task.starts.length, 3)
})
