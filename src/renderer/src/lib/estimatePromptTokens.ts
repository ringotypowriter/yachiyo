import type { Message, MessageFileAttachment, MessageImageRecord } from '@renderer/app/types'
import { estimateTextTokens } from '../../../shared/yachiyo/estimateTokens.ts'

const BASELINE_PROMPT_TOKENS = 6000
const DRAFT_TOKEN_OVERHEAD = 10
const INLINE_IMAGE_TOKENS = 1000
const ATTACHMENT_PATH_ROOT = '/workspace'

interface PromptAttachmentReference {
  filename: string
  mediaType: string
  workspacePath?: string
}

interface DraftPromptAttachment extends PromptAttachmentReference {
  dataUrl?: string
}

function buildAttachmentPath(filename: string, workspacePath?: string): string {
  return workspacePath?.trim() || `${ATTACHMENT_PATH_ROOT}/${filename}`
}

function buildAttachedFilesBlock(input: {
  images?: MessageImageRecord[]
  attachments?: PromptAttachmentReference[]
}): string | null {
  const imageEntries = (input.images ?? [])
    .filter((image) => image.workspacePath)
    .map(
      (image) =>
        `- ${image.filename ?? 'image'} (${image.mediaType}) → ${image.workspacePath} [sent inline]`
    )

  const attachmentEntries = (input.attachments ?? []).map(
    (attachment) =>
      `- ${attachment.filename} (${attachment.mediaType}) → ${buildAttachmentPath(
        attachment.filename,
        attachment.workspacePath
      )}`
  )

  const entries = [...imageEntries, ...attachmentEntries]
  if (entries.length === 0) return null

  return ['<attached_files>', ...entries, '</attached_files>'].join('\n')
}

function estimateAttachedFilesTokens(input: {
  images?: MessageImageRecord[]
  attachments?: PromptAttachmentReference[]
}): number {
  const block = buildAttachedFilesBlock(input)
  return block ? estimateTextTokens(block) : 0
}

export function estimateDraftPromptTokens(input: {
  text: string
  imageCount?: number
  files?: DraftPromptAttachment[]
}): number {
  let tokens = estimateTextTokens(input.text)
  tokens += (input.imageCount ?? 0) * INLINE_IMAGE_TOKENS
  tokens += estimateAttachedFilesTokens({ attachments: input.files })
  return tokens > 0 ? Math.round(tokens + DRAFT_TOKEN_OVERHEAD) : 0
}

export function estimatePromptTokens(messages: Message[]): number {
  let tokens = BASELINE_PROMPT_TOKENS
  for (const msg of messages) {
    tokens += estimateTextTokens(msg.content)
    tokens += (msg.images?.length ?? 0) * INLINE_IMAGE_TOKENS
    tokens += estimateAttachedFilesTokens({
      images: msg.images,
      attachments: msg.attachments as MessageFileAttachment[] | undefined
    })
  }
  return Math.round(tokens)
}
