/**
 * Image-aware URL transform for Streamdown.
 *
 * Policy — when image rendering is enabled in an assistant message:
 *   - `https:` / `http:` ............. pass through (actual loading is gated by
 *                                      the custom `img` component which shows
 *                                      a placeholder-with-download-button).
 *   - `data:` ......................... pass through (inline base64 payloads).
 *   - `yachiyo-asset:` ............... pass through (our local-file scheme).
 *   - absolute filesystem paths ...... rewritten to `yachiyo-asset://local/?p=`.
 *   - relative filesystem paths ....... rewritten against `basePath`, when provided.
 *   - everything else ................ dropped (returns `null`).
 *
 * This function is pure — no React, no DOM — so it can be unit-tested directly.
 */

export const YACHIYO_ASSET_SCHEME = 'yachiyo-asset'

export interface BuildAssetUrlOptions {
  assetVersion?: string | number | null
}

export interface TransformImageSrcOptions {
  basePath?: string | null
  assetVersion?: string | number | null
}

/**
 * True when `value` looks like an absolute filesystem path we can serve.
 * Accepts POSIX roots (`/foo/bar`) and Windows roots (`C:\foo`, `C:/foo`).
 */
export function isAbsolutePathLike(value: string): boolean {
  if (!value) return false
  if (value.startsWith('/')) return true
  return /^[a-zA-Z]:[\\/]/.test(value)
}

/**
 * Build a `yachiyo-asset://local/?p=...` URL for an absolute path.
 * Returns `null` if the input is not an absolute path.
 */
export function buildAssetUrl(absPath: string, options: BuildAssetUrlOptions = {}): string | null {
  if (!isAbsolutePathLike(absPath)) return null
  return appendAssetVersion(
    `${YACHIYO_ASSET_SCHEME}://local/?p=${encodeURIComponent(absPath)}`,
    options.assetVersion
  )
}

/**
 * True if `src` is a remote HTTP/HTTPS URL that should be gated behind the
 * user-confirmation download flow.
 */
export function isRemoteImageUrl(src: string): boolean {
  return /^https?:\/\//i.test(src)
}

/**
 * True if `src` is served by our local-asset scheme.
 */
export function isAssetUrl(src: string): boolean {
  return src.startsWith(`${YACHIYO_ASSET_SCHEME}://`)
}

function appendAssetVersion(
  assetUrl: string,
  assetVersion: string | number | null | undefined
): string {
  if (assetVersion == null || assetVersion === '') return assetUrl

  const version = String(assetVersion)
  try {
    const url = new URL(assetUrl)
    url.searchParams.set('v', version)
    return url.toString()
  } catch {
    const separator = assetUrl.includes('?') ? '&' : '?'
    return `${assetUrl}${separator}v=${encodeURIComponent(version)}`
  }
}

/**
 * Extract the original absolute filesystem path from a `yachiyo-asset://`
 * URL, or return `null` if it isn't one. Useful for "Reveal in Finder".
 */
export function extractLocalPath(src: string): string | null {
  if (!isAssetUrl(src)) return null
  try {
    const url = new URL(src)
    const raw = url.searchParams.get('p')
    return raw ?? null
  } catch {
    return null
  }
}

function safeDecode(input: string): string {
  try {
    return decodeURIComponent(input)
  } catch {
    return input
  }
}

function hasUrlScheme(value: string): boolean {
  return /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(value) && !isAbsolutePathLike(value)
}

function isDirectRelativePathLike(value: string): boolean {
  if (!value) return false
  if (value.startsWith('/') || value.startsWith('\\')) return false
  if (value.startsWith('#') || value.startsWith('?')) return false
  if (hasUrlScheme(value)) return false
  return !isAbsolutePathLike(value)
}

export function isDirectImagePathCandidate(src: string): boolean {
  const trimmed = src.trim()
  if (!trimmed) return false
  if (isRemoteImageUrl(trimmed)) return false
  if (trimmed.startsWith('data:image/')) return false
  if (isAssetUrl(trimmed)) return false
  if (trimmed.toLowerCase().startsWith('file:')) return true

  const decoded = safeDecode(trimmed)
  return (
    isAbsolutePathLike(trimmed) ||
    isAbsolutePathLike(decoded) ||
    isDirectRelativePathLike(trimmed) ||
    isDirectRelativePathLike(decoded)
  )
}

function normalizePathLike(value: string): string | null {
  const slashPath = value.replace(/\\/g, '/')
  const driveMatch = /^[a-zA-Z]:/.exec(slashPath)
  const drive = driveMatch?.[0] ?? ''
  const rest = drive ? slashPath.slice(drive.length) : slashPath
  const absolute = Boolean(drive) || rest.startsWith('/')
  const segments: string[] = []

  for (const segment of rest.split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      if (segments.length > 0) {
        segments.pop()
      } else if (!absolute) {
        segments.push(segment)
      }
      continue
    }
    segments.push(segment)
  }

  if (drive) return `${drive}/${segments.join('/')}`
  if (absolute) return `/${segments.join('/')}`
  return segments.join('/') || '.'
}

function isPathInsideBase(candidate: string, basePath: string): boolean {
  const windows = /^[a-zA-Z]:[\\/]/.test(basePath)
  const normalizedCandidate = windows ? candidate.toLowerCase() : candidate
  const normalizedBase = windows ? basePath.toLowerCase() : basePath
  const basePrefix = normalizedBase.endsWith('/') ? normalizedBase : `${normalizedBase}/`
  return normalizedCandidate === normalizedBase || normalizedCandidate.startsWith(basePrefix)
}

function resolveRelativePath(relativePath: string, basePath?: string | null): string | null {
  const base = basePath?.trim()
  if (!base || !isAbsolutePathLike(base)) return null

  const decoded = safeDecode(relativePath.trim())
  if (!isDirectRelativePathLike(decoded)) return null

  const normalizedBase = normalizePathLike(base)
  if (!normalizedBase || !isAbsolutePathLike(normalizedBase)) return null

  const normalizedCandidate = normalizePathLike(`${normalizedBase}/${decoded}`)
  if (!normalizedCandidate || !isAbsolutePathLike(normalizedCandidate)) return null
  if (!isPathInsideBase(normalizedCandidate, normalizedBase)) return null

  return normalizedCandidate
}

function fileUrlToAbsolutePath(rawUrl: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return null
  }

  if (parsed.protocol !== 'file:') return null
  if (parsed.hostname && parsed.hostname !== 'localhost') return null

  const decodedPath = safeDecode(parsed.pathname)
  const path = /^\/[a-zA-Z]:\//.test(decodedPath) ? decodedPath.slice(1) : decodedPath
  return isAbsolutePathLike(path) ? path : null
}

/**
 * Transform an image `src` according to the policy above. Non-image URLs
 * (e.g. link hrefs) fall through to the caller's default transform.
 *
 * Note on Windows paths: markdown parsers percent-encode backslashes in
 * angle-bracketed destinations, so `![x](<C:\foo\bar.png>)` reaches this
 * function as `C:%5Cfoo%5Cbar.png`. We try the raw form first, then the
 * decoded form, so both shapes are recognized as absolute paths.
 */
export function transformImageSrc(
  url: string,
  options: TransformImageSrcOptions = {}
): string | null {
  if (!url) return null

  const trimmed = url.trim()
  if (!trimmed) return null

  if (isRemoteImageUrl(trimmed)) return trimmed
  if (trimmed.startsWith('data:image/')) return trimmed
  if (isAssetUrl(trimmed)) return appendAssetVersion(trimmed, options.assetVersion)

  const filePath = fileUrlToAbsolutePath(trimmed)
  if (filePath) return buildAssetUrl(filePath, { assetVersion: options.assetVersion })
  if (trimmed.toLowerCase().startsWith('file:')) return null

  // Prefer the decoded form whenever it differs — markdown parsers
  // percent-encode backslashes and spaces in angle-bracketed destinations,
  // so `C:%5Cfoo%5Cbar.png` and `/Users/a/with%20space.png` must resolve
  // to their decoded absolute paths, not the encoded literals.
  const decoded = safeDecode(trimmed)
  const candidate = decoded !== trimmed && isAbsolutePathLike(decoded) ? decoded : trimmed

  if (isAbsolutePathLike(candidate)) {
    return buildAssetUrl(candidate, { assetVersion: options.assetVersion })
  }

  const relativePath = resolveRelativePath(candidate, options.basePath)
  if (relativePath) return buildAssetUrl(relativePath, { assetVersion: options.assetVersion })

  return null
}
