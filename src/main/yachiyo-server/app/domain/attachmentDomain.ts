import { access, appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'

import { extractBase64DataUrlPayload } from '../../../../shared/yachiyo/messageContent.ts'
import type {
  MessageFileAttachment,
  MessageImageRecord,
  SendChatAttachment
} from '../../../../shared/yachiyo/protocol.ts'

const IMAGE_MEDIA_TYPE_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg'
}

const YACHIYO_ATTACHMENT_DIR = '.yachiyo'
const GIT_EXCLUDE_ENTRY = `\n# yachiyo managed files\n${YACHIYO_ATTACHMENT_DIR}/\n`

function extFromMediaType(mediaType: string): string {
  return IMAGE_MEDIA_TYPE_EXT[mediaType] ?? '.bin'
}

function sanitizeFilename(filename: string): string {
  return filename.replace(/[/\\:*?"<>|]/g, '_')
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
  const attachmentDir = join(
    workspacePath,
    YACHIYO_ATTACHMENT_DIR,
    'attachments',
    messageId
  )
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
      const ext = image.filename ? extname(image.filename) : extFromMediaType(image.mediaType)
      const base = image.filename
        ? basename(image.filename, extname(image.filename))
        : `image_${index + 1}`
      const safeName = sanitizeFilename(`${base}${ext}`)
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
    input.attachments.map(async (attachment) => {
      const safeName = sanitizeFilename(attachment.filename)
      const filePath = join(attachmentDir, safeName)
      await writeBase64File(filePath, attachment.filename, attachment.dataUrl)
      return {
        filename: attachment.filename,
        mediaType: attachment.mediaType,
        workspacePath: filePath
      }
    })
  )
}
