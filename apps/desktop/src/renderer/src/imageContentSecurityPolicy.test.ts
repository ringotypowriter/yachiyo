import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// The real document policy governs local previews and isolated generated UI.
test('main window CSP permits isolated UI and local previews without remote scripts or JavaScript eval', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
  const policy = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/)?.[1]
  assert.ok(policy, 'Main window must declare its content security policy')
  const directives = new Map(
    policy.split(';').map((directive) => {
      const [name, ...sources] = directive.trim().split(/\s+/)
      return [name, sources] as const
    })
  )
  assert.deepEqual(directives.get('img-src'), ["'self'", 'data:', 'blob:'])
  assert.deepEqual(directives.get('script-src'), ["'self'", "'wasm-unsafe-eval'"])
  assert.deepEqual(directives.get('worker-src'), ["'self'", 'blob:'])
  assert.deepEqual(directives.get('font-src'), ["'self'", 'blob:'])
  assert.deepEqual(directives.get('frame-src'), ["'self'", 'yachiyo-ui:'])
  assert.deepEqual(directives.get('default-src'), ["'self'"])
})
