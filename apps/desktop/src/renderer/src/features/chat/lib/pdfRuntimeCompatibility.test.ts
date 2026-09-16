import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'

test('production PDF.js main and worker handle pages without Electron-missing Map APIs', () => {
  // Resolve the actual renderer imports, not a test-only PDF.js build. Vite's
  // ?url becomes a file URL here; the worker still executes in a separate realm.
  const component = new URL('../components/PdfDocument.tsx', import.meta.url)
  const imports = ts.preProcessFile(readFileSync(component, 'utf8')).importedFiles
  const main = imports.find(
    ({ fileName }) => fileName.startsWith('pdfjs-dist') && !fileName.includes('?')
  )
  const worker = imports.find(
    ({ fileName }) => fileName.startsWith('pdfjs-dist') && fileName.endsWith('?url')
  )
  assert.ok(main)
  assert.ok(worker)
  const require = createRequire(component)
  const mainUrl = pathToFileURL(require.resolve(main.fileName)).href
  const workerUrl = pathToFileURL(require.resolve(worker.fileName.replace(/\?url$/, ''))).href
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import assert from 'node:assert/strict'
    import { Worker } from 'node:worker_threads'

    // No hand-written language polyfills: only PDF.js's own compatibility code
    // may restore these APIs, independently in each realm.
    delete Map.prototype.getOrInsertComputed
    delete WeakMap.prototype.getOrInsertComputed
    assert.equal(typeof Map.prototype.getOrInsertComputed, 'undefined')
    const { getDocument, PDFWorker, OPS } = await import(${JSON.stringify(mainUrl)})

    const workerSource = \`
      import { parentPort } from 'node:worker_threads'
      delete Map.prototype.getOrInsertComputed
      delete WeakMap.prototype.getOrInsertComputed
      const { WorkerMessageHandler } = await import(${JSON.stringify(workerUrl)})
      WorkerMessageHandler.initializeFromPort({
        postMessage: (data, transfer) => parentPort.postMessage(data, transfer),
        addEventListener: (type, listener, options) => {
          const receive = data => listener({ data })
          parentPort.on(type, receive)
          options?.signal?.addEventListener('abort', () => parentPort.off(type, receive))
        }
      })
    \`
    const thread = new Worker(new URL('data:text/javascript,' + encodeURIComponent(workerSource)))
    const port = {
      postMessage: (data, transfer) => thread.postMessage(data, transfer),
      addEventListener: (type, listener, options) => {
        const receive = data => listener({ data })
        thread.on(type, receive)
        options?.signal?.addEventListener('abort', () => thread.off(type, receive))
      }
    }
    const pdfWorker = PDFWorker.create({ port })
    const content = '0 0 1 rg 10 10 40 30 re f'
    const objects = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      // Inherited and page resources force the worker's resource dictionary
      // merge, which also needs getOrInsertComputed in its independent realm.
      '<< /Type /Pages /Kids [3 0 R] /Count 1 /Resources << /ProcSet [/PDF] >> >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Contents 4 0 R /Resources << /ProcSet [/PDF] >> >>',
      '<< /Length ' + content.length + ' >>\\nstream\\n' + content + '\\nendstream'
    ]
    let pdf = '%PDF-1.7\\n'
    const offsets = [0]
    for (const [index, object] of objects.entries()) {
      offsets.push(pdf.length)
      pdf += (index + 1) + ' 0 obj\\n' + object + '\\nendobj\\n'
    }
    const xref = pdf.length
    pdf += 'xref\\n0 5\\n0000000000 65535 f \\n' + offsets.slice(1)
      .map(offset => String(offset).padStart(10, '0') + ' 00000 n \\n').join('') +
      'trailer\\n<< /Size 5 /Root 1 0 R >>\\nstartxref\\n' + xref + '\\n%%EOF'
    const task = getDocument({ data: new TextEncoder().encode(pdf), worker: pdfWorker, verbosity: 0 })
    try {
      const document = await task.promise
      assert.equal(document.numPages, 1)
      const page = await document.getPage(1)
      assert.equal(page.getViewport({ scale: 1 }).height, 400)
      // Parsing alone passed before the fix. These exercise the rendering
      // operator stream and WorkerTransport's #methodPromises cache.
      assert.equal((await document.getMetadata()).info.PDFFormatVersion, '1.7')
      assert.equal((await document.getMetadata()).info.PDFFormatVersion, '1.7')
      const operators = await page.getOperatorList()
      assert.ok(operators.fnArray.includes(OPS.constructPath))
      console.log('production main + isolated worker: page and operators OK')
    } finally {
      await task.destroy()
      pdfWorker.destroy()
      await thread.terminate()
    }
  `
    ],
    { encoding: 'utf8', timeout: 30_000 }
  )
  assert.equal(result.error, undefined)
  assert.equal(result.status, 0, result.stderr + result.stdout)
  assert.match(result.stdout, /page and operators OK/)
})
