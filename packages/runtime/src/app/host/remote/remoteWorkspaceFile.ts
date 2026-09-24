import { constants } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import { basename, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

// Stay within the same response budget as images.get, including base64 expansion.
export const MAX_REMOTE_FILE_BYTES = 6 * 1024 * 1024

/** Read a local Markdown target only inside the authenticated thread's workspace. */
export async function readRemoteWorkspaceFile(
  workspacePath: string,
  source: string
): Promise<{ filename: string; mediaType: string; data: string }> {
  const value = source.trim()
  if (!value || value.includes('\0')) throw new Error('Invalid file path.')
  let path: string
  if (/^file:/i.test(value)) {
    path = fileURLToPath(value)
  } else {
    if (/^[a-z][a-z\d+.-]*:/i.test(value) || value.startsWith('//')) {
      throw new Error('Only workspace files can be previewed.')
    }
    path = decodeURIComponent(value.split(/[?#]/, 1)[0])
  }
  const root = await realpath(workspacePath)
  const target = await realpath(resolve(root, path))
  const fromRoot = relative(root, target)
  if (!fromRoot || fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error('File is outside this conversation workspace.')
  }
  const bytes = await readBoundedRemoteFile(target)
  return {
    filename: basename(target),
    mediaType: 'application/octet-stream',
    data: bytes.toString('base64')
  }
}

/** The caller must authorize and canonicalize this local path before reading. */
export async function readBoundedRemoteFile(target: string): Promise<Buffer> {
  const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = await file.stat()
    if (!stat.isFile()) throw new Error('Only regular files can be previewed.')
    if (stat.size > MAX_REMOTE_FILE_BYTES)
      throw new Error('File is too large to preview (6 MB maximum).')
    // Bound the actual read as well: the file can grow after stat.
    const bytes = Buffer.alloc(MAX_REMOTE_FILE_BYTES + 1)
    let length = 0
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, null)
      if (!bytesRead) break
      length += bytesRead
    }
    if (length > MAX_REMOTE_FILE_BYTES)
      throw new Error('File is too large to preview (6 MB maximum).')
    return bytes.subarray(0, length)
  } finally {
    await file.close()
  }
}
