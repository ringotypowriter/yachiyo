/**
 * Last-resort URL for a QQ image when the rkey-signed URL from napcat's
 * get_image is rejected by the CDN (a chronic napcat issue — observed even on
 * a freshly restarted instance). QQ's cache file is named by the image's MD5,
 * and the legacy unauthenticated gchatpic endpoint still serves by MD5.
 */
export function buildLegacyQQImageUrl(cacheFilePath: string): string | null {
  const basename = cacheFilePath.split('/').pop() ?? ''
  const match = /^([0-9a-fA-F]{32})(?:\.\w+)?$/.exec(basename)
  if (!match) {
    return null
  }
  return `https://gchat.qpic.cn/gchatpic_new/0/0-0-${match[1].toUpperCase()}/0`
}
