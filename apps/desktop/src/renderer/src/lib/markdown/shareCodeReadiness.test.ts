import assert from 'node:assert/strict'
import test from 'node:test'
import type { PluginConfig } from 'streamdown'
import { trackShareCodeReadiness } from './shareCodeReadiness'

type CodePlugin = NonNullable<PluginConfig['code']>
type Highlighted = NonNullable<ReturnType<CodePlugin['highlight']>>
const tokens = { tokens: [], fg: '#000', bg: '#fff' } as unknown as Highlighted
const options = {
  code: 'const answer = 42',
  language: 'typescript',
  themes: ['github-light', 'github-dark']
} as Parameters<CodePlugin['highlight']>[0]
function plugin(highlight: CodePlugin['highlight']): CodePlugin {
  return {
    name: 'shiki',
    type: 'code-highlighter',
    getSupportedLanguages: () => [],
    getThemes: () => options.themes,
    supportsLanguage: () => true,
    highlight
  }
}

test('cold grammars remain pending until every outstanding highlight callback resolves', () => {
  const callbacks: Array<(value: Highlighted) => void> = []
  const states: boolean[] = []
  const wrapped = trackShareCodeReadiness(
    plugin((_options, callback) => {
      callbacks.push(callback!)
      return null
    }),
    (pending) => states.push(pending)
  )
  const delivered: Highlighted[] = []
  assert.equal(
    wrapped.highlight(options, (value) => delivered.push(value)),
    null
  )
  assert.equal(wrapped.highlight(options), null)
  assert.deepEqual(states, [true, true])
  callbacks[0](tokens)
  assert.deepEqual(states, [true, true, true])
  callbacks[1](tokens)
  assert.deepEqual(states, [true, true, true, false])
  assert.deepEqual(delivered, [tokens])
})

test('cached synchronous highlights do not block capture', () => {
  const states: boolean[] = []
  const wrapped = trackShareCodeReadiness(
    plugin(() => tokens),
    (pending) => states.push(pending)
  )
  assert.equal(wrapped.highlight(options), tokens)
  assert.deepEqual(states, [false])
})

test('a grammar whose callback never arrives cannot be mistaken for ready', () => {
  const states: boolean[] = []
  const wrapped = trackShareCodeReadiness(
    plugin(() => null),
    (pending) => states.push(pending)
  )
  wrapped.highlight(options)
  assert.deepEqual(states, [true])
})
