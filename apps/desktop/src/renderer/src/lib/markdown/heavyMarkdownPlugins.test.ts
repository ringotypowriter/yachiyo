import assert from 'node:assert/strict'
import test from 'node:test'

import { detectHeavyMarkdownFeatures } from './heavyMarkdownPlugins.ts'

test('detectHeavyMarkdownFeatures keeps ordinary markdown on the light path', () => {
  assert.deepEqual(
    detectHeavyMarkdownFeatures('A **bold** note with `inline code` and a [link](./file.ts).'),
    { code: false, math: false, mermaid: false }
  )
})

test('detectHeavyMarkdownFeatures requests only the needed plugin families', () => {
  assert.deepEqual(detectHeavyMarkdownFeatures('```ts\nconst answer = 42\n```'), {
    code: true,
    math: false,
    mermaid: false
  })
  assert.deepEqual(detectHeavyMarkdownFeatures('~~~mermaid\ngraph TD\n~~~'), {
    code: true,
    math: false,
    mermaid: true
  })
  assert.deepEqual(detectHeavyMarkdownFeatures('The result is $x + y$.'), {
    code: false,
    math: true,
    mermaid: false
  })
})
