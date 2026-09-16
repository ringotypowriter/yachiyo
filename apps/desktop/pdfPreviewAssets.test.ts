import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import { build, createServer } from 'vite'
import { pdfPreviewAssets } from './pdfPreviewAssets.ts'

const root = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'))
const samples = [
  'cmaps/UniGB-UCS2-H.bcmap',
  'standard_fonts/LiberationSans-Regular.ttf',
  'wasm/openjpeg.wasm',
  'wasm/openjpeg_nowasm_fallback.js',
  'standard_fonts/LICENSE_LIBERATION'
]

test('serves local PDF resources in development without a CDN', async () => {
  const server = await createServer({
    configFile: false,
    plugins: [pdfPreviewAssets()],
    server: { host: '127.0.0.1', port: 0 },
    logLevel: 'silent'
  })
  try {
    await server.listen()
    const address = server.httpServer!.address()
    assert.ok(address && typeof address === 'object')
    for (const sample of samples) {
      const response = await fetch(`http://127.0.0.1:${address.port}/pdfjs/${sample}`)
      assert.equal(response.status, 200)
      assert.deepEqual(
        Buffer.from(await response.arrayBuffer()),
        readFileSync(resolve(root, sample))
      )
      if (sample.endsWith('.wasm'))
        assert.equal(response.headers.get('content-type'), 'application/wasm')
    }
  } finally {
    await server.close()
  }
})

test('emits identical resources at stable relative paths for packaged file URLs', async () => {
  const result = await build({
    configFile: false,
    plugins: [
      pdfPreviewAssets(),
      {
        name: 'test-entry',
        resolveId: (id) => (id === 'test-entry' ? id : null),
        load: (id) => (id === 'test-entry' ? 'export default 1' : null)
      }
    ],
    logLevel: 'silent',
    build: { write: false, rollupOptions: { input: 'test-entry' } }
  })
  assert.ok('output' in result)
  for (const sample of samples) {
    const asset = result.output.find((output) => output.fileName === `pdfjs/${sample}`)
    assert.ok(asset && asset.type === 'asset')
    assert.deepEqual(Buffer.from(asset.source), readFileSync(resolve(root, sample)))
  }
})
