/**
 * Parse OneBot v11 CQ-coded messages to extract image file identifiers.
 *
 * OneBot v11 encodes rich content as CQ codes inside `rawMessage`:
 *   [CQ:image,file=abc.jpg,url=https://example.com/img.jpg]
 *
 * The `url` param is often a Tencent CDN link that expires or requires auth.
 * Instead we extract the `file` identifier which can be passed to the OneBot
 * `get_image` API to get a reliable download path.
 *
 * This module strips image CQ codes from the raw string, returning the
 * cleaned text and a list of image file identifiers for downstream resolution.
 */

const CQ_IMAGE_RE = /\[CQ:image(?:,[^\]]*)?\]/g
const CQ_FILE_PARAM_RE = /\bfile=([^,\]]+)/

export interface CQImageRef {
  /** The `file` parameter from the CQ code — used with OneBot `get_image` API. */
  file: string
}

/**
 * Strip `[CQ:image,...]` segments from a raw OneBot message.
 *
 * @returns cleaned text (non-image CQ codes preserved) and extracted image references.
 */
export function parseCQImages(rawMessage: string): { text: string; images: CQImageRef[] } {
  const images: CQImageRef[] = []

  const text = rawMessage.replace(CQ_IMAGE_RE, (match) => {
    const fileMatch = match.match(CQ_FILE_PARAM_RE)
    if (fileMatch?.[1]) {
      images.push({ file: fileMatch[1] })
    }
    return ''
  })

  return { text: text.trim(), images }
}
