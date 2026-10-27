import assert from 'node:assert/strict'
import test from 'node:test'
import { probeObelisk } from './obelisk.ts'

test('Obelisk diagnosis distinguishes a missing CLI, old CLI, and a Node build without FTS5', () => {
  assert.equal(
    probeObelisk(() => ({
      status: null,
      stdout: '',
      error: Object.assign(new Error(), { code: 'ENOENT' })
    })).issue,
    'missing'
  )
  assert.equal(
    probeObelisk(() => ({ status: 1, stdout: 'Usage: obelisk --query' })).issue,
    'unsupported'
  )
  const probe = (fts5: boolean): { status: number; stdout: string } => ({
    status: fts5 ? 0 : 1,
    stdout: JSON.stringify({
      ok: fts5,
      version: '0.3.0',
      fts5,
      providers: ['codex', 'yachiyo'],
      secret: 'do-not-copy'
    })
  })
  assert.equal(probeObelisk(() => probe(false)).issue, 'fts5')
  const ready = probeObelisk(() => probe(true))
  assert.equal(ready.ready, true)
  assert.equal(ready.version, '0.3.0')
  assert.doesNotMatch(JSON.stringify(ready), /do-not-copy/)
})

test('Obelisk diagnosis requires the native Yachiyo provider and does not expose subprocess output', () => {
  const report = probeObelisk(() => ({
    status: 0,
    stdout: JSON.stringify({
      ok: true,
      fts5: true,
      version: 'sk-secret',
      providers: ['codex']
    })
  }))
  assert.equal(report.ready, false)
  assert.equal(report.issue, 'unsupported')
  assert.equal(report.version, null)
  assert.equal(
    probeObelisk(() => ({ status: null, stdout: '', error: new Error('private env') })).issue,
    'probe-failed'
  )
})
