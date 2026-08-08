import { readFile, stat } from 'node:fs/promises'
import { TextDecoder } from 'node:util'

export const MAX_SNAPSHOT_FILE_BYTES = 10 * 1024 * 1024

const utf8Decoder = new TextDecoder('utf-8', { fatal: true })

export function isSnapshotTextContent(content: Buffer): boolean {
  for (const byte of content) {
    if ((byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) || byte === 0x7f) {
      return false
    }
  }

  try {
    utf8Decoder.decode(content)
    return true
  } catch {
    return false
  }
}

export async function readSnapshotEligibleFile(path: string): Promise<Buffer | null> {
  const fileStat = await stat(path)
  if (!fileStat.isFile() || fileStat.size > MAX_SNAPSHOT_FILE_BYTES) {
    return null
  }

  const content = await readFile(path)
  if (content.length > MAX_SNAPSHOT_FILE_BYTES || !isSnapshotTextContent(content)) {
    return null
  }

  return content
}
