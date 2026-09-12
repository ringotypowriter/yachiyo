import assert from 'node:assert/strict'
import test from 'node:test'
import { samplePointingPose, getPointingRestTarget } from './pointingMotion.ts'

test('the gesture begins and ends with no hand and a relaxed pose', () => {
  assert.deepEqual(samplePointingPose(0), samplePointingPose(1))
  assert.equal(samplePointingPose(0).handRadius, 0)
  assert.deepEqual(samplePointingPose(0.75), samplePointingPose(1))
})

test('settling never replays a hand that has already returned', () => {
  assert.equal(getPointingRestTarget(0.2), 0)
  assert.equal(getPointingRestTarget(0.5), 1)
  const target = getPointingRestTarget(0.8)
  for (let i = 0; i <= 10; i++) {
    assert.equal(samplePointingPose(0.8 + ((target - 0.8) * i) / 10).handRadius, 0)
  }
})

test('eyes look toward the text before the hand separates from the body', () => {
  const look = samplePointingPose(0.08)
  assert.ok(look.gazeX > 0 && look.gazeY < 0)
  assert.equal(look.handRadius, 0)
  const point = samplePointingPose(0.31)
  assert.ok(point.handX > 78 && point.handY < 20)
  assert.ok(point.handRadius > 3 && point.handRadius < 4.5)
  assert.ok(point.bodyRotate < 0)
})

test('a small emphasis moves the hand, then it merges back before the quiet interval', () => {
  assert.notEqual(samplePointingPose(0.31).handY, samplePointingPose(0.36).handY)
  assert.ok(samplePointingPose(0.5).handX < 70)
  assert.equal(samplePointingPose(0.58).handRadius, 0)
})

test('all hand poses remain inside the fixed canvas and snapshots do not mutate', () => {
  const saved = samplePointingPose(0.31)
  const copy = { ...saved }
  for (let i = 0; i <= 100; i++) {
    const pose = samplePointingPose(i / 100)
    assert.ok(pose.handX + pose.handRadius < 100)
    assert.ok(pose.handY - pose.handRadius > 0)
  }
  assert.deepEqual(saved, copy)
})
