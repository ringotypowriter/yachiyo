import assert from 'node:assert/strict'
import test from 'node:test'

import { extractPdfText } from './pdfExtract.ts'

/**
 * Builds a minimal valid PDF buffer containing the given text lines.
 * This constructs a bare-minimum PDF 1.4 with a single page and text stream.
 */
function buildMinimalPdf(lines: string[]): Buffer {
  const streamContent = lines
    .map((line, i) => `BT /F1 12 Tf 72 ${700 - i * 20} Td (${line}) Tj ET`)
    .join('\n')
  const streamBytes = Buffer.byteLength(streamContent, 'ascii')

  const objects = [
    // 1 0 obj — catalog
    `1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj`,
    // 2 0 obj — pages
    `2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj`,
    // 3 0 obj — page
    `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj`,
    // 4 0 obj — content stream
    `4 0 obj\n<< /Length ${streamBytes} >>\nstream\n${streamContent}\nendstream\nendobj`,
    // 5 0 obj — font
    `5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj`
  ]

  let body = ''
  const offsets: number[] = []
  const header = '%PDF-1.4\n'
  body += header

  for (const obj of objects) {
    offsets.push(Buffer.byteLength(body, 'ascii'))
    body += obj + '\n'
  }

  const xrefOffset = Buffer.byteLength(body, 'ascii')
  body += `xref\n0 ${objects.length + 1}\n`
  body += `0000000000 65535 f \n`
  for (const offset of offsets) {
    body += `${String(offset).padStart(10, '0')} 00000 n \n`
  }
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`
  body += `startxref\n${xrefOffset}\n%%EOF\n`

  return Buffer.from(body, 'ascii')
}

function buildEmptyPdf(): Buffer {
  const streamContent = ''
  const streamBytes = 0

  const objects = [
    `1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj`,
    `2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj`,
    `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << >> >>\nendobj`,
    `4 0 obj\n<< /Length ${streamBytes} >>\nstream\n${streamContent}\nendstream\nendobj`
  ]

  let body = '%PDF-1.4\n'
  const offsets: number[] = []

  for (const obj of objects) {
    offsets.push(Buffer.byteLength(body, 'ascii'))
    body += obj + '\n'
  }

  const xrefOffset = Buffer.byteLength(body, 'ascii')
  body += `xref\n0 ${objects.length + 1}\n`
  body += `0000000000 65535 f \n`
  for (const offset of offsets) {
    body += `${String(offset).padStart(10, '0')} 00000 n \n`
  }
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`
  body += `startxref\n${xrefOffset}\n%%EOF\n`

  return Buffer.from(body, 'ascii')
}

test('extractPdfText returns text from a text-rich PDF', async () => {
  const pdf = buildMinimalPdf([
    'Hello world',
    'This is a test PDF with enough text content',
    'to pass the sparse detection threshold easily.'
  ])

  const result = await extractPdfText(pdf)

  assert.equal(result.totalPages, 1)
  assert.ok(result.text.includes('Hello world'))
  assert.ok(result.text.includes('test PDF'))
  assert.equal(result.sparse, false)
  assert.equal(result.hint, undefined)
})

test('extractPdfText detects sparse content and provides hint', async () => {
  const pdf = buildEmptyPdf()
  const result = await extractPdfText(pdf)

  assert.equal(result.totalPages, 1)
  assert.equal(result.sparse, true)
  assert.ok(result.hint)
  assert.ok(result.hint.includes('images'))
  assert.ok(result.hint.includes('pdftoppm'))
})

test('extractPdfText includes page count in output', async () => {
  const pdf = buildMinimalPdf(['Some content here for page count test.'])
  const result = await extractPdfText(pdf)

  assert.ok(result.text.includes('Pages: 1'))
})

test('extractPdfText rejects invalid data gracefully', async () => {
  const garbage = Buffer.from('this is not a pdf at all')

  await assert.rejects(() => extractPdfText(garbage))
})
