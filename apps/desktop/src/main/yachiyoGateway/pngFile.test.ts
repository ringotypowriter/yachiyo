import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizePngBytes, normalizePngFilename } from './pngFile.ts'

const pngHeader = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

test('normalizePngFilename returns a safe png filename', () => {
  assert.equal(normalizePngFilename(), 'diagram.png')
  assert.equal(normalizePngFilename('chart'), 'chart.png')
  assert.equal(normalizePngFilename('folder/chart.PNG'), 'folder-chart.PNG')
})

test('normalizePngBytes accepts PNG bytes from an ArrayBuffer', () => {
  const bytes = normalizePngBytes(pngHeader.buffer)

  assert.equal(Buffer.isBuffer(bytes), true)
  assert.deepEqual([...bytes.subarray(0, pngHeader.byteLength)], [...pngHeader])
})

test('normalizePngBytes rejects non-PNG bytes', () => {
  assert.throws(() => normalizePngBytes(new Uint8Array([1, 2, 3]).buffer), /valid PNG/)
})
