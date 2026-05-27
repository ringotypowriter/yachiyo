import assert from 'node:assert/strict'
import test from 'node:test'
import { parseHTML } from 'linkedom'

import { createMermaidOptions, readThemeVariantFromRoot } from './mermaidTheme.ts'

test('createMermaidOptions maps the light app variant to the default Mermaid theme', () => {
  assert.deepEqual(createMermaidOptions('light'), { config: { theme: 'default' } })
})

test('createMermaidOptions maps the dark app variant to the dark Mermaid theme', () => {
  assert.deepEqual(createMermaidOptions('dark'), { config: { theme: 'dark' } })
})

test('readThemeVariantFromRoot reads the applied Yachiyo theme variant', () => {
  const { document } = parseHTML('<html data-yachiyo-theme-variant="dark"><body></body></html>')

  assert.equal(readThemeVariantFromRoot(document.documentElement), 'dark')
})
