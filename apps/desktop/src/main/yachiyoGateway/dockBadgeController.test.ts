import assert from 'node:assert/strict'
import test from 'node:test'

import { createDockBadgeController } from './dockBadgeController.ts'

test('increments and clears the macOS app badge count', () => {
  const badgeCounts: number[] = []
  const controller = createDockBadgeController({
    platform: 'darwin',
    setBadgeCount: (count) => {
      badgeCounts.push(count)
      return true
    }
  })

  assert.equal(controller.getCount(), 0)

  controller.increment()
  controller.increment()
  controller.clear()

  assert.equal(controller.getCount(), 0)
  assert.deepEqual(badgeCounts, [1, 2, 0])
})

test('clears a stale macOS app badge even when the local count is already zero', () => {
  const badgeCounts: number[] = []
  const controller = createDockBadgeController({
    platform: 'darwin',
    setBadgeCount: (count) => {
      badgeCounts.push(count)
      return true
    }
  })

  controller.clear()

  assert.equal(controller.getCount(), 0)
  assert.deepEqual(badgeCounts, [0])
})

test('does not set an app badge outside macOS', () => {
  const badgeCounts: number[] = []
  const controller = createDockBadgeController({
    platform: 'linux',
    setBadgeCount: (count) => {
      badgeCounts.push(count)
      return true
    }
  })

  controller.increment()
  controller.clear()

  assert.equal(controller.getCount(), 0)
  assert.deepEqual(badgeCounts, [])
})
