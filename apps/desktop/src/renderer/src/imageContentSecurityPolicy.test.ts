import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// The real document policy governs generated PNG previews, not the capture engine.
test('main window CSP permits local PNG object URLs without widening scripts or remote images', () => {
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
  assert.deepEqual(directives.get('script-src'), ["'self'"])
  assert.deepEqual(directives.get('default-src'), ["'self'"])
})
