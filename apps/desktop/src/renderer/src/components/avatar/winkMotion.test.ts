import assert from 'node:assert/strict'
import test from 'node:test'
import { sampleWinkPose } from './winkMotion.ts'

test('wink starts and ends with exactly the same relaxed face and body', () => {
  assert.deepEqual(sampleWinkPose(0), sampleWinkPose(1))
  assert.deepEqual(sampleWinkPose(-1), sampleWinkPose(0))
  assert.deepEqual(sampleWinkPose(2), sampleWinkPose(1))
})

test('eye contour changes through squeeze, tight wink and release without swapping paths', () => {
  const frames = [0, 0.16, 0.34, 0.5, 0.7, 0.84].map((progress) => sampleWinkPose(progress))
  assert.equal(new Set(frames.map((frame) => frame.eye)).size, frames.length)
  for (const frame of frames) {
    assert.equal(frame.eye.replace(/[-\d. ,]/g, ''), 'MCCCCZ')
  }
  assert.notEqual(sampleWinkPose(0.4).eye, sampleWinkPose(0.401).eye)
})

test('the face anticipates and the body settles after the eye opens', () => {
  assert.notEqual(sampleWinkPose(0.16).gazeX, 0)
  assert.notEqual(sampleWinkPose(0.5).otherEye, sampleWinkPose(0).otherEye)
  assert.notEqual(sampleWinkPose(0.84).otherEye, sampleWinkPose(0).otherEye)
  assert.notEqual(sampleWinkPose(0.84).bodyRotate, 0)
  assert.equal(sampleWinkPose(1).bodyRotate, 0)
})

test('either eye can wink inward, with the body and gaze following that side', () => {
  const left = sampleWinkPose(0.5, 'left')
  const right = sampleWinkPose(0.5, 'right')
  const coordinates = (path: string): number[] => path.match(/-?\d+(?:\.\d+)?/g)!.map(Number)
  const l = coordinates(left.eye)
  const r = coordinates(right.eye)
  l.forEach((value, i) => assert.ok(Math.abs(r[i] - (i % 2 === 0 ? 100 - value : value)) < 0.00001))
  assert.equal(right.bodyRotate, -left.bodyRotate)
  assert.equal(right.gazeX, -left.gazeX)
  assert.deepEqual(sampleWinkPose(0, 'right'), sampleWinkPose(1, 'right'))
})

test('the other eye stays rounded with a subtle squeeze and lift', () => {
  const points = sampleWinkPose(0.5)
    .otherEye.match(/-?\d+(?:\.\d+)?/g)!
    .map(Number)
  assert.ok(points[13] > points[7], 'the eye remains convex, not a smiling arch')
  assert.ok(points[13] - points[1] >= 6.5, 'the eye stays nearly as open as the resting 8px oval')
  assert.ok(points[7] < 31 && points[7] >= 30.5, 'only a slight upward lift')
  assert.ok(sampleWinkPose(0.5).bodyY < sampleWinkPose(0.62).bodyY)
  assert.ok(sampleWinkPose(0.72).bodyY < sampleWinkPose(0.62).bodyY)
})
