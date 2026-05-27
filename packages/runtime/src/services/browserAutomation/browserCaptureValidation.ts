export function assertNonEmptyScreenshotByteLength(byteLength: number): void {
  if (byteLength > 0) return

  throw new Error('Browser produced an empty screenshot capture.')
}
