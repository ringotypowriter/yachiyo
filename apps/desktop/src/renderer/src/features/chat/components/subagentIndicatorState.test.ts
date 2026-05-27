import assert from 'node:assert/strict'
import test from 'node:test'

import { buildSubagentIndicatorStream, canCancelFromIndicator } from './subagentIndicatorState.ts'

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
