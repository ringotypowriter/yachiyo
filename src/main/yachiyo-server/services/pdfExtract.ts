/**
 * Shared PDF text extraction utility using `unpdf`.
 * Lazy-loads the library on first use — zero cost when no PDF is processed.
 * Opens the document proxy once and reuses it for both text and metadata extraction.
 */

// Only flag as sparse when extraction yields near-zero text.
// Short but legitimate text (receipts, cover sheets) should not trigger the hint.
const SPARSE_MAX_TOTAL_CHARS = 10

const SPARSE_CONTENT_HINT = [
  'Note: This PDF appears to contain mostly images, scanned content, or non-text elements.',
  'Text extraction yielded minimal results.',
  'For better results, consider using bash to convert PDF pages to images, then read the images directly:',
  '  - `pdftoppm -png input.pdf output-prefix` (poppler-utils) to split pages into PNG images',
  '  - `magick input.pdf page-%d.png` (ImageMagick) as an alternative',
  '  - Then use the read tool on each page image to see the content visually',
  'Alternatively, check if a PDF processing skill is available via skillsRead.'
].join('\n')

export interface PdfExtractionResult {
  text: string
  totalPages: number
  sparse: boolean
  hint?: string
}

export async function extractPdfText(
  data: ArrayBuffer | Uint8Array | Buffer
): Promise<PdfExtractionResult> {
  const { getDocumentProxy, extractText, getMeta } = await import('unpdf')

  // unpdf requires Uint8Array — convert Buffer/ArrayBuffer
  const uint8 =
    data instanceof Uint8Array && !(data instanceof Buffer)
      ? data
      : new Uint8Array(
          data instanceof Buffer
            ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
            : data
        )

  // Open document once, reuse proxy for both calls
  const proxy = await getDocumentProxy(uint8)

  try {
    const [textResult, metaResult] = await Promise.all([
      extractText(proxy, { mergePages: false }),
      getMeta(proxy).catch(() => undefined)
    ])

    const { totalPages, text: pages } = textResult
    const merged = pages.join('\n\n').trim()

    const sparse = totalPages > 0 && merged.length <= SPARSE_MAX_TOTAL_CHARS

    const titleLine = metaResult?.info?.Title ? `Title: ${metaResult.info.Title}\n` : ''
    const authorLine = metaResult?.info?.Author ? `Author: ${metaResult.info.Author}\n` : ''
    const header = `${titleLine}${authorLine}Pages: ${totalPages}\n`

    const body = sparse && !merged ? '' : merged

    const hint = sparse ? SPARSE_CONTENT_HINT : undefined

    return {
      text: `${header}\n${body}`.trim(),
      totalPages,
      sparse,
      hint
    }
  } finally {
    proxy.cleanup()
  }
}
