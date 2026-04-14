import { createHash } from 'node:crypto'
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { resolveYachiyoFileHistoryDir } from '../../config/paths.ts'

/** SHA-256 hex digest of the given content. */
export function hashContent(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}

/** Short workspace hash for directory naming (first 16 hex chars of SHA-256). */
export function hashWorkspacePath(workspacePath: string): string {
  return createHash('sha256').update(workspacePath).digest('hex').slice(0, 16)
}

function backupsDir(workspaceHash: string): string {
  return join(resolveYachiyoFileHistoryDir(), workspaceHash, 'backups')
}

function blobPath(workspaceHash: string, hash: string): string {
  return join(backupsDir(workspaceHash), hash)
}

/** Store a blob in the CAS pool. Returns the content hash. Deduplicates automatically. */
export async function storeBlob(workspaceHash: string, content: string | Buffer): Promise<string> {
  const hash = hashContent(content)
  const dest = blobPath(workspaceHash, hash)
  const dir = backupsDir(workspaceHash)
  await mkdir(dir, { recursive: true })
  // Write atomically — if the blob already exists, overwriting with identical content is fine.
  await writeFile(dest, content)
  return hash
}

/** Read a blob from the CAS pool. */
export async function readBlob(workspaceHash: string, hash: string): Promise<Buffer> {
  return readFile(blobPath(workspaceHash, hash))
}

/** Delete a blob from the CAS pool (for GC). Silently ignores missing blobs. */
export async function deleteBlob(workspaceHash: string, hash: string): Promise<void> {
  try {
    await unlink(blobPath(workspaceHash, hash))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
}
