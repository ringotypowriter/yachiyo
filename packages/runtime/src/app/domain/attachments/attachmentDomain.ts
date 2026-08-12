import { access, appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'

import { extractBase64DataUrlPayload } from '@yachiyo/shared/messageContent'
import { resolvePreferredAttachmentExtension } from '@yachiyo/shared/attachmentFileTypes'
import type {
  MessageFileAttachment,
  MessageImageRecord,
  SendChatAttachment
} from '@yachiyo/shared/protocol'

const IMAGE_MEDIA_TYPE_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/bmp': '.bmp',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/heic': '.heic',
  'image/heif': '.heif',
  'image/svg+xml': '.svg'
}

const YACHIYO_ATTACHMENT_DIR = '.yachiyo'
const GIT_EXCLUDE_ENTRY = `\n# yachiyo managed files\n${YACHIYO_ATTACHMENT_DIR}/\n`
const MAX_STORAGE_FILENAME_BYTES = 255

function extFromMediaType(mediaType: string): string | undefined {
  return IMAGE_MEDIA_TYPE_EXT[mediaType]
}

function sanitizeFilename(filename: string): string {
  return filename.replace(/[/\\:*?"<>|]/g, '_')
}

function truncateUtf8(value: string, maxBytes: number): string {
  let result = ''
  let byteLength = 0
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character)
    if (byteLength + characterBytes > maxBytes) break
    result += character
    byteLength += characterBytes
  }
  return result
}

function buildStorageFilename(prefix: string, base: string, extension: string): string {
  const safeBase = sanitizeFilename(base)
  const extensionBytes = MAX_STORAGE_FILENAME_BYTES - Buffer.byteLength(prefix)
  const safeExtension = truncateUtf8(sanitizeFilename(extension), Math.max(0, extensionBytes))
  const baseBytes = extensionBytes - Buffer.byteLength(safeExtension)
  return `${prefix}${truncateUtf8(safeBase, Math.max(0, baseBytes))}${safeExtension}`
}

async function writeBase64File(filePath: string, filename: string, dataUrl: string): Promise<void> {
  const parsed = extractBase64DataUrlPayload(dataUrl)
  if (!parsed) {
    throw new Error(`Cannot save attachment "${filename}": data URL is not valid base64`)
  }
  const buffer = Buffer.from(parsed.base64, 'base64')
  await writeFile(filePath, buffer)
}

async function ensureGitExclude(workspacePath: string): Promise<void> {
  const gitDir = join(workspacePath, '.git')
  try {
    await access(gitDir)
  } catch {
    // No .git directory — nothing to do
    return
  }

  const excludePath = join(gitDir, 'info', 'exclude')
  await mkdir(join(gitDir, 'info'), { recursive: true })

  let existing = ''
  try {
    existing = await readFile(excludePath, 'utf8')
  } catch {
    // File doesn't exist yet — will be created
  }

  if (!existing.includes(`${YACHIYO_ATTACHMENT_DIR}/`)) {
    await appendFile(excludePath, GIT_EXCLUDE_ENTRY, 'utf8')
  }
}

async function ensureAttachmentDir(workspacePath: string, messageId: string): Promise<string> {
  const attachmentDir = join(workspacePath, YACHIYO_ATTACHMENT_DIR, 'attachments', messageId)
  await mkdir(attachmentDir, { recursive: true })
  await ensureGitExclude(workspacePath)
  return attachmentDir
}

export async function saveImageFilesToWorkspace(input: {
  workspacePath: string
  messageId: string
  images: MessageImageRecord[]
}): Promise<MessageImageRecord[]> {
  if (input.images.length === 0) {
    return []
  }

  const attachmentDir = await ensureAttachmentDir(input.workspacePath, input.messageId)

  return Promise.all(
    input.images.map(async (image, index) => {
      const originalName = image.filename ?? `image_${index + 1}`
      const filenameExt = image.filename ? extname(image.filename) : ''
      // Channel images use the normalized media type after conversion. Composer images are an
      // open set of original browser files, so retain their extension when no mapping exists.
      const ext = (extFromMediaType(image.mediaType) ?? filenameExt) || '.bin'
      const base = image.filename ? basename(image.filename, filenameExt) : `image_${index + 1}`
      const safeName = buildStorageFilename(`${index + 1}-`, base, ext)
      const filePath = join(attachmentDir, safeName)
      await writeBase64File(filePath, originalName, image.dataUrl)
      return { ...image, workspacePath: filePath }
    })
  )
}

export async function saveFileAttachmentsToWorkspace(input: {
  workspacePath: string
  messageId: string
  attachments: SendChatAttachment[]
}): Promise<MessageFileAttachment[]> {
  if (input.attachments.length === 0) {
    return []
  }

  const attachmentDir = await ensureAttachmentDir(input.workspacePath, input.messageId)

  return Promise.all(
    input.attachments.map(async (attachment, index) => {
      const filenameExtension = extname(attachment.filename)
      const storageExtension =
        filenameExtension || resolvePreferredAttachmentExtension(attachment.mediaType) || ''
      const filenameBase = filenameExtension
        ? attachment.filename.slice(0, -filenameExtension.length)
        : attachment.filename
      const safeName = buildStorageFilename(`${index + 1}-`, filenameBase, storageExtension)
      const filePath = join(attachmentDir, safeName)
      await writeBase64File(filePath, attachment.filename, attachment.dataUrl)
      return {
        filename: attachment.filename,
        mediaType: attachment.mediaType,
        workspacePath: filePath,
        ...(attachment.attachmentIndex !== undefined
          ? { attachmentIndex: attachment.attachmentIndex }
          : {})
      }
    })
  )
}
