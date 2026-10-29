import assert from 'node:assert/strict'
import test from 'node:test'

import { createRemoteKeepAwake, type PowerApi } from './keepAwake.ts'

function createPower(onBattery: boolean): PowerApi & {
  active: Set<number>
  setBattery(value: boolean): void
} {
  const active = new Set<number>()
  const listeners = new Set<() => void>()
  let nextId = 1
  let battery = onBattery
  return {
    active,
    startBlocker: () => {
      const id = nextId++
      active.add(id)
      return id
    },
    stopBlocker: (id) => active.delete(id),
    isOnBattery: () => battery,
    onPowerSourceChange: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    setBattery(value) {
      battery = value
      listeners.forEach((listener) => listener())
    }
  }
}

test('the blocker is held only while wanted and on AC power', () => {
  const power = createPower(false)
  const keepAwake = createRemoteKeepAwake(power)
  assert.equal(power.active.size, 0)

  keepAwake.setWanted(true)
  assert.equal(power.active.size, 1)
  keepAwake.setWanted(true)
  assert.equal(power.active.size, 1, 'no duplicate blockers')

  power.setBattery(true)
  assert.equal(power.active.size, 0)
  power.setBattery(false)
  assert.equal(power.active.size, 1)

  keepAwake.setWanted(false)
  assert.equal(power.active.size, 0)
})

test('dispose releases the blocker and stops following power changes', () => {
  const power = createPower(false)
  const keepAwake = createRemoteKeepAwake(power)
  keepAwake.setWanted(true)
  keepAwake.dispose()
  power.setBattery(true)
  power.setBattery(false)
  assert.equal(power.active.size, 0)
})
