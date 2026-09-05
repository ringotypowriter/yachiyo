import { open, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import {
  decodePreviewText,
  getFilePreviewKind,
  MAX_FILE_PREVIEW_BYTES,
  type FilePreviewContent,
  type ReadFilePreviewInput
} from '@yachiyo/shared/filePreview'

export async function readFilePreview(input: ReadFilePreviewInput): Promise<FilePreviewContent> {
  if (!input.workspacePath) throw new Error('A workspace is required to preview this file.')
  const workspace = await realpath(input.workspacePath)
  const path = await realpath(resolve(workspace, input.path))
  const local = relative(workspace, path)
  if (
    !local ||
    local === '..' ||
    local.startsWith('../') ||
    local.startsWith('..\\') ||
    isAbsolute(local)
  ) {
    throw new Error('The file is outside this workspace.')
  }
  const kind = getFilePreviewKind(path)
  if (!kind || kind === 'image') throw new Error('Open this file in its default application.')
  const file = await open(path, 'r')
  try {
    const stats = await file.stat()
    if (!stats.isFile() || stats.size > MAX_FILE_PREVIEW_BYTES)
      throw new Error('Preview supports files up to 25 MiB.')
    const bytes = Buffer.alloc(Math.min(stats.size + 1, MAX_FILE_PREVIEW_BYTES + 1))
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0)
    if (bytesRead > MAX_FILE_PREVIEW_BYTES) throw new Error('This file is too large to preview.')
    const data = bytes.subarray(0, bytesRead)
    if (kind === 'pdf') {
      if (!data.subarray(0, 5).equals(Buffer.from('%PDF-')))
        throw new Error('This file is not a valid PDF.')
      return { path, kind, content: data.toString('base64') }
    }
    return { path, kind, content: decodePreviewText(data) }
  } finally {
    await file.close()
  }
}
