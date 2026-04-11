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
 *   - everything else ................ dropped (returns `null`).
 *
 * This function is pure — no React, no DOM — so it can be unit-tested directly.
 */

export const YACHIYO_ASSET_SCHEME = 'yachiyo-asset'

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
export function buildAssetUrl(absPath: string): string | null {
  if (!isAbsolutePathLike(absPath)) return null
  return `${YACHIYO_ASSET_SCHEME}://local/?p=${encodeURIComponent(absPath)}`
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

function safeDecode(input: string): string {
  try {
    return decodeURIComponent(input)
  } catch {
    return input
  }
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
export function transformImageSrc(url: string): string | null {
  if (!url) return null

  const trimmed = url.trim()
  if (!trimmed) return null

  if (isRemoteImageUrl(trimmed)) return trimmed
  if (trimmed.startsWith('data:image/')) return trimmed
  if (isAssetUrl(trimmed)) return trimmed

  // Prefer the decoded form whenever it differs — markdown parsers
  // percent-encode backslashes and spaces in angle-bracketed destinations,
  // so `C:%5Cfoo%5Cbar.png` and `/Users/a/with%20space.png` must resolve
  // to their decoded absolute paths, not the encoded literals.
  const decoded = safeDecode(trimmed)
  const candidate = decoded !== trimmed && isAbsolutePathLike(decoded) ? decoded : trimmed

  if (isAbsolutePathLike(candidate)) {
    return buildAssetUrl(candidate)
  }

  // `file://` is intentionally dropped — Electron blocks it from the renderer
  // and we want images to go through our allowlisted scheme so we stay
  // in control of what the renderer is allowed to load.
  return null
}
