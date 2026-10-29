import assert from 'node:assert/strict'
import test from 'node:test'
import { code, type HighlightOptions, type HighlightResult } from '@streamdown/code'

function options(source: string): HighlightOptions {
  return { code: source, language: 'typescript', themes: code.getThemes() }
}

function highlight(source: string): Promise<HighlightResult> {
  return new Promise((resolve) => {
    const cached = code.highlight(options(source), resolve)
    if (cached) resolve(cached)
  })
}

test('highlight history evicts old results while recently used code stays cached', async () => {
  const old = 'const evictedHistory = 1'
  const hot = 'const activeEditor = 2'
  const original = await highlight(old)
  const active = await highlight(hot)
  for (let index = 0; index < 100; index++) {
    await highlight(`const historyItem${index} = ${index}`)
    assert.strictEqual(code.highlight(options(hot)), active)
  }
  const regenerated = Promise.withResolvers<HighlightResult>()
  assert.ok(code.highlight(options(old), regenerated.resolve) === null)
  assert.deepEqual(await regenerated.promise, original)
})

test('large code revisions also evict cached content without exhausting the entry limit', async () => {
  const body = '// A line of source code with a comment\n'.repeat(1800)
  const first = '// first revision\n' + body
  const original = await highlight(first)
  for (let revision = 0; revision < 8; revision++) {
    await highlight(`// revision ${revision}\n` + body)
  }
  const regenerated = Promise.withResolvers<HighlightResult>()
  assert.ok(code.highlight(options(first), regenerated.resolve) === null)
  assert.deepEqual(await regenerated.promise, original)
})

test('oversized code still delivers complete tokens to concurrent readers without being retained', async () => {
  const source = '// oversized source\n' + '// A line of source code with a comment\n'.repeat(14000)
  const [first, second] = await Promise.all([highlight(source), highlight(source)])
  assert.deepEqual(first, second)
  assert.equal(
    first.tokens.map((line) => line.map((token) => token.content).join('')).join('\n'),
    source
  )
  const regenerated = Promise.withResolvers<HighlightResult>()
  assert.ok(code.highlight(options(source), regenerated.resolve) === null)
  assert.deepEqual(await regenerated.promise, first)
})

test('concurrent readers of one revision do not evict other recently used code', async () => {
  const activeSource = 'const visibleCode = true'
  const active = await highlight(activeSource)
  const source =
    '// concurrent revision\n' + '// A line of source code with a comment\n'.repeat(3500)
  const [first, second, third] = await Promise.all([
    highlight(source),
    highlight(source),
    highlight(source)
  ])
  assert.deepEqual(first, second)
  assert.deepEqual(first, third)
  assert.strictEqual(code.highlight(options(activeSource)), active)
})
