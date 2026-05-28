import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildAgentIdentities,
  buildSubagentIndicatorStream,
  canCancelFromIndicator
} from './subagentIndicatorState.ts'

test('canCancelFromIndicator disables inline cancel when multiple agents are active', () => {
  assert.equal(
    canCancelFromIndicator([
      { delegationId: 'a', agentName: 'Worker A', progress: 'alpha' },
      { delegationId: 'b', agentName: 'Worker B', progress: 'beta' }
    ]),
    false
  )
  assert.equal(
    canCancelFromIndicator([{ delegationId: 'a', agentName: 'Worker A', progress: 'alpha' }]),
    true
  )
})

test('buildSubagentIndicatorStream preserves interleaved progress order', () => {
  const stream = buildSubagentIndicatorStream([
    { delegationId: 'a', agentName: 'Worker A', chunk: 'alpha\n' },
    { delegationId: 'b', agentName: 'Worker B', chunk: 'beta\n' },
    { delegationId: 'a', agentName: 'Worker A', chunk: 'gamma\n' }
  ])

  const alphaIndex = stream.indexOf('[Worker A]\nalpha')
  const betaIndex = stream.indexOf('[Worker B]\nbeta')
  const gammaIndex = stream.indexOf('[Worker A]\ngamma')

  assert.notEqual(alphaIndex, -1)
  assert.notEqual(betaIndex, -1)
  assert.notEqual(gammaIndex, -1)
  assert.ok(alphaIndex < betaIndex && betaIndex < gammaIndex)
})

test('buildSubagentIndicatorStream preserves split chunks for the same agent', () => {
  const stream = buildSubagentIndicatorStream([
    { delegationId: 'a', agentName: 'Worker A', chunk: 'hel' },
    { delegationId: 'a', agentName: 'Worker A', chunk: 'lo\n\n' }
  ])

  assert.equal(stream, '[Worker A]\nhello\n\n')
})

test('buildSubagentIndicatorStream uses identities when provided', () => {
  const identities = {
    a: { delegationId: 'a', agentName: 'Worker A', index: 1, color: '#3b82f6' },
    b: { delegationId: 'b', agentName: 'Worker B', index: 2, color: '#10b981' }
  }

  const stream = buildSubagentIndicatorStream(
    [
      { delegationId: 'a', agentName: 'Worker A', chunk: 'alpha\n' },
      { delegationId: 'b', agentName: 'Worker B', chunk: 'beta\n' }
    ],
    identities
  )

  assert.ok(stream.includes('[#1 Worker A]\nalpha'))
  assert.ok(stream.includes('[#2 Worker B]\nbeta'))
})

test('buildAgentIdentities assigns indexes and colors', () => {
  const agents = [
    { delegationId: 'a', agentName: 'explore', progress: '' },
    { delegationId: 'b', agentName: 'explore', progress: '' },
    { delegationId: 'c', agentName: 'review', progress: '' }
  ]

  const identities = buildAgentIdentities(agents)

  assert.equal(identities.length, 3)
  assert.equal(identities[0].index, 1)
  assert.equal(identities[0].color, '#3b82f6')
  assert.equal(identities[1].index, 2)
  assert.equal(identities[1].color, '#10b981')
  assert.equal(identities[2].index, 3)
  assert.equal(identities[2].color, '#f59e0b')
})
