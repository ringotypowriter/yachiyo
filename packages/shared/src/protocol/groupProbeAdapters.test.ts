import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveGroupProbeHeadlessAdapter } from './groupProbeAdapters.ts'

test('resolveGroupProbeHeadlessAdapter activates only when the selected group model matches', () => {
  const adapter = {
    adapter: 'claude-code' as const,
    providerName: 'Claude Code',
    model: 'sonnet'
  }

  assert.deepEqual(
    resolveGroupProbeHeadlessAdapter(adapter, {
      providerName: 'Claude Code',
      model: 'sonnet'
    }),
    adapter
  )
  assert.equal(
    resolveGroupProbeHeadlessAdapter(adapter, {
      providerName: 'Claude Code',
      model: 'opus'
    }),
    undefined
  )
  assert.equal(resolveGroupProbeHeadlessAdapter(adapter, undefined), undefined)
})
