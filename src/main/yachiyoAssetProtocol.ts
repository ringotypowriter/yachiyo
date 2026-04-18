import { protocol } from 'electron'
import { readFile, stat } from 'node:fs/promises'
import type { Stats } from 'node:fs'
import { posix as posixPath, win32 as win32Path } from 'node:path'

/**
 * Custom scheme for serving local image files to the renderer.
 *
 * URL shape: `yachiyo-asset://local/?p=<urlencoded-absolute-path>`
 *
 * Only files whose extensions match a known image MIME type are served.
 * All other requests return 404. This gives markdown `![alt](...)` in
 * assistant messages a safe way to reference arbitrary files on disk
 * without turning on `webSecurity: false`.
 */
export const YACHIYO_ASSET_SCHEME = 'yachiyo-asset'

const IMAGE_EXT_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon'
}

export interface ResolvedAsset {
  absPath: string
  mimeType: string
}

/**
 * True when `value` looks like a POSIX absolute path (`/foo/bar`).
 */
function isPosixAbsolute(value: string): boolean {
  return value.startsWith('/')
}

/**
 * True when `value` looks like a Windows absolute path with a drive
 * letter (`C:\foo` or `C:/foo`).
 */
function isWindowsAbsolute(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(value)
}

/**
 * True for either POSIX or Windows absolute paths. Cross-platform on
 * purpose — a message history imported from another OS should not
 * silently drop its image references just because `node:path` on the
 * current host doesn't recognise the foreign shape.
 */
function isAbsolutePathLike(value: string): boolean {
  return isPosixAbsolute(value) || isWindowsAbsolute(value)
}

/**
 * Normalize a path using the style-appropriate `node:path` variant.
 * POSIX paths go through `posix.normalize`; Windows paths go through
 * `win32.normalize`. This keeps `..` collapsing consistent regardless
 * of which OS the app is running on.
 */
function normalizeCrossPlatform(value: string): string {
  if (isWindowsAbsolute(value)) return win32Path.normalize(value)
  return posixPath.normalize(value)
}

/**
 * Parse a yachiyo-asset:// URL and return the absolute path + MIME type,
 * or `null` if the URL is malformed, the path is not absolute, or the
 * extension is not a recognised image type.
 *
 * Pure — no filesystem access, safe to unit-test.
 */
export function resolveAssetUrl(rawUrl: string): ResolvedAsset | null {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return null
  }

  if (url.protocol !== `${YACHIYO_ASSET_SCHEME}:`) return null
  if (url.hostname !== 'local') return null

  const rawPath = url.searchParams.get('p')
  if (!rawPath) return null

  if (!isAbsolutePathLike(rawPath)) return null
  const normalized = normalizeCrossPlatform(rawPath)
  if (!isAbsolutePathLike(normalized)) return null

  const dotIdx = normalized.lastIndexOf('.')
  if (dotIdx < 0) return null
  const ext = normalized.slice(dotIdx).toLowerCase()
  const mimeType = IMAGE_EXT_MIME[ext]
  if (!mimeType) return null

  return { absPath: normalized, mimeType }
}

/**
 * Build a `yachiyo-asset://local/?p=...` URL for an absolute path.
 * Returns `null` if the path is not absolute on any platform we support.
 */
export function buildAssetUrl(absPath: string): string | null {
  if (!isAbsolutePathLike(absPath)) return null
  return `${YACHIYO_ASSET_SCHEME}://local/?p=${encodeURIComponent(absPath)}`
}

export interface AssetCacheHeaders {
  etag: string
  lastModified: string
}

/**
 * Derive cache-validation headers from a file stat. The weak ETag combines
 * mtime (ms) and size — enough to pick up any rewrite of the same path.
 * Without this, the renderer's HTTP cache would happily serve the previous
 * body when an agent overwrites a file and re-renders the same URL.
 */
export function buildAssetCacheHeaders(stats: Stats): AssetCacheHeaders {
  return {
    etag: `W/"${Math.floor(stats.mtimeMs)}-${stats.size}"`,
    lastModified: stats.mtime.toUTCString()
  }
}

/**
 * Register the scheme as privileged. MUST be called before `app.whenReady()`.
 */
export function registerYachiyoAssetScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: YACHIYO_ASSET_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        bypassCSP: true
      }
    }
  ])
}

/**
 * Install the request handler. Call after `app.whenReady()`.
 */
export function installYachiyoAssetProtocolHandler(): void {
  protocol.handle(YACHIYO_ASSET_SCHEME, async (request) => {
    const parsed = resolveAssetUrl(request.url)
    if (!parsed) {
      return new Response('Not found', { status: 404 })
    }

    try {
      const stats = await stat(parsed.absPath)
      const { etag, lastModified } = buildAssetCacheHeaders(stats)

      // Honor conditional GETs so the renderer can skip the readFile when
      // the file hasn't changed since its last request.
      const ifNoneMatch = request.headers.get('if-none-match')
      if (ifNoneMatch && ifNoneMatch === etag) {
        return new Response(null, {
          status: 304,
          headers: { ETag: etag, 'Last-Modified': lastModified }
        })
      }

      const data = await readFile(parsed.absPath)
      // Buffer is a Uint8Array subclass, which Response accepts directly.
      return new Response(new Uint8Array(data), {
        status: 200,
        headers: {
          'Content-Type': parsed.mimeType,
          // no-cache (not no-store) — the renderer may keep a copy, but
          // must revalidate every request so an overwrite of the same path
          // is picked up the next time the same URL renders.
          'Cache-Control': 'no-cache',
          ETag: etag,
          'Last-Modified': lastModified
        }
      })
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'EACCES' || code === 'EISDIR') {
        return new Response('Not found', { status: 404 })
      }
      console.error('[yachiyo-asset] read error', error)
      return new Response('Error', { status: 500 })
    }
  })
}
