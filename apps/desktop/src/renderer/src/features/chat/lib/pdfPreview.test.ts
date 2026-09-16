import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from 'pdfjs-dist'
import { decodePdf, pdfPageNumber, pdfZoom, renderPdfPage } from './pdfPreview.ts'

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: Error) => void
} {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

function setup(): {
  pageRequest: ReturnType<typeof deferred<PDFPageProxy>>
  painting: ReturnType<typeof deferred<void>>
  page: PDFPageProxy
  canvas: HTMLCanvasElement
  requested: number[]
  errors: unknown[]
  cancel: () => void
  counts: () => { renders: number; cancellations: number; cleanups: number; ready: number }
} {
  const pageRequest = deferred<PDFPageProxy>()
  const painting = deferred<void>()
  const requested: number[] = []
  let renders = 0
  let cancellations = 0
  let cleanups = 0
  let ready = 0
  const errors: unknown[] = []
  const canvas = { width: 0, height: 0, style: {} } as HTMLCanvasElement
  const page = {
    getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale }),
    render: () => {
      renders++
      return {
        promise: painting.promise,
        cancel: () => {
          cancellations++
          painting.reject(new Error('Rendering cancelled'))
        }
      } as RenderTask
    },
    cleanup: () => {
      cleanups++
    }
  } as unknown as PDFPageProxy
  const document = {
    getPage: (number: number) => {
      requested.push(number)
      return pageRequest.promise
    }
  } as Pick<PDFDocumentProxy, 'getPage'>
  const cancel = renderPdfPage({
    document,
    pageNumber: 2,
    zoom: 1.5,
    pixelRatio: 2,
    canvas,
    onReady: () => {
      ready++
    },
    onError: (error) => errors.push(error)
  })
  return {
    pageRequest,
    painting,
    page,
    canvas,
    requested,
    errors,
    cancel,
    counts: () => ({ renders, cancellations, cleanups, ready })
  }
}

const flush = async (): Promise<void> => {
  await new Promise<void>((resolve) => setImmediate(resolve))
}

test('decodes IPC base64 without changing binary PDF bytes', () => {
  const bytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0, 128, 255])
  assert.deepEqual(decodePdf(bytes.toString('base64')), new Uint8Array(bytes))
  assert.throws(() => decodePdf('not base64!'))
})

test('navigation and zoom stay within their bounds', () => {
  assert.equal(pdfPageNumber(0, 5), 1)
  assert.equal(pdfPageNumber(6, 5), 5)
  assert.equal(pdfPageNumber(3, 5), 3)
  assert.equal(pdfZoom(0), 0.25)
  assert.equal(pdfZoom(4), 3)
  assert.equal(pdfZoom(1.25), 1.25)
})

test('renders only the requested page at zoom and high-DPI backing resolution', async () => {
  const state = setup()
  assert.deepEqual(state.requested, [2])
  state.pageRequest.resolve(state.page)
  await flush()
  assert.equal(state.canvas.width, 1800)
  assert.equal(state.canvas.height, 2400)
  assert.equal(state.canvas.style.width, '900px')
  assert.equal(state.counts().ready, 0)
  state.painting.resolve()
  await flush()
  assert.deepEqual(state.counts(), { renders: 1, cancellations: 0, cleanups: 1, ready: 1 })
  assert.deepEqual(state.errors, [])
})

test('unmount before getPage resolves prevents rendering and releases the page', async () => {
  const state = setup()
  state.cancel()
  state.pageRequest.resolve(state.page)
  await flush()
  assert.equal(state.counts().renders, 0)
  assert.equal(state.counts().ready, 0)
  assert.ok(state.counts().cleanups >= 1)
  assert.deepEqual(state.errors, [])
})

test('changing page or zoom cancels painting without publishing stale errors', async () => {
  const state = setup()
  state.pageRequest.resolve(state.page)
  await flush()
  state.cancel()
  await flush()
  assert.deepEqual(state.counts(), { renders: 1, cancellations: 1, cleanups: 1, ready: 0 })
  assert.deepEqual(state.errors, [])
})

test('page retrieval and rendering failures reach the error UI callback', async () => {
  const retrieval = setup()
  const error = new Error('Invalid page')
  retrieval.pageRequest.reject(error)
  await flush()
  assert.deepEqual(retrieval.errors, [error])
  const rendering = setup()
  rendering.pageRequest.resolve(rendering.page)
  await flush()
  rendering.painting.reject(error)
  await flush()
  assert.deepEqual(rendering.errors, [error])
  assert.equal(rendering.counts().cleanups, 1)
})

test('late failures after unmount are ignored', async () => {
  const state = setup()
  state.cancel()
  state.pageRequest.reject(new Error('Document destroyed'))
  await flush()
  assert.deepEqual(state.errors, [])
})

// Exercise the real parser as well as the asynchronous canvas lifecycle above.
test('PDF.js opens decoded IPC content, navigates pages, and rejects corrupt PDFs', async () => {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 500 600] >>'
  ]
  let pdf = '%PDF-1.7\n'
  const offsets = [0]
  for (const [index, object] of objects.entries()) {
    offsets.push(pdf.length)
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`
  }
  const xref = pdf.length
  pdf += `xref\n0 5\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('')}trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`
  const task = getDocument({ data: decodePdf(Buffer.from(pdf).toString('base64')), verbosity: 0 })
  try {
    const document = await task.promise
    assert.equal(document.numPages, 2)
    assert.equal((await document.getPage(2)).getViewport({ scale: 1 }).width, 500)
    assert.equal((await document.getPage(1)).getViewport({ scale: 1 }).height, 400)
  } finally {
    await task.destroy()
  }
  const invalid = getDocument({
    data: decodePdf(Buffer.from('not a PDF').toString('base64')),
    verbosity: 0
  })
  try {
    await assert.rejects(invalid.promise, /Invalid PDF/)
  } finally {
    await invalid.destroy()
  }
})
