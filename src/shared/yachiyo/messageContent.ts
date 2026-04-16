import type { MessageImageRecord } from './protocol'

interface MessageAttachmentLike {
  filename: string
  mediaType: string
}

interface MessagePayloadLike {
  content: string
  images?: MessageImageRecord[]
  attachments?: MessageAttachmentLike[]
}

export function normalizeMessageImages(images?: MessageImageRecord[]): MessageImageRecord[] {
  return (images ?? []).flatMap((image) => {
    const dataUrl = image.dataUrl.trim()
    const mediaType = image.mediaType.trim()
    const filename = image.filename?.trim()

    if (!dataUrl || !mediaType) {
      return []
    }

    return [
      {
        dataUrl,
        mediaType,
        ...(filename ? { filename } : {}),
        ...(image.workspacePath ? { workspacePath: image.workspacePath.trim() } : {}),
        ...(image.altText ? { altText: image.altText.trim() } : {})
      }
    ]
  })
}

export function extractBase64DataUrlPayload(dataUrl: string): {
  mediaType: string
  base64: string
} | null {
  const trimmed = dataUrl.trim()
  if (!trimmed.startsWith('data:')) {
    return null
  }

  const commaIndex = trimmed.indexOf(',')
  if (commaIndex < 0) {
    return null
  }

  const header = trimmed.slice(5, commaIndex)
  const payload = trimmed.slice(commaIndex + 1).trim()
  const [mediaType, encoding] = header.split(';', 2)

  if (!mediaType || encoding !== 'base64' || !payload) {
    return null
  }

  return {
    mediaType,
    base64: payload
  }
}

export function hasMessagePayload(input: MessagePayloadLike): boolean {
  return (
    input.content.trim().length > 0 ||
    normalizeMessageImages(input.images).length > 0 ||
    (input.attachments?.length ?? 0) > 0
  )
}

export function stripMarkdown(md: string): string {
  let s = md
  // fenced code blocks → keep content only
  s = s.replace(/```[\s\S]*?```/g, (m) => {
    const inner = m.replace(/^```\w*\n?/, '').replace(/\n?```$/, '')
    return inner
  })
  // images / links → keep display text
  s = s.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
  // inline code
  s = s.replace(/`([^`]+)`/g, '$1')
  // headings
  s = s.replace(/^#{1,6}\s+/gm, '')
  // bold / italic / strikethrough
  s = s.replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1')
  s = s.replace(/_{1,3}([^_]+)_{1,3}/g, '$1')
  s = s.replace(/~~([^~]+)~~/g, '$1')
  // blockquotes
  s = s.replace(/^>+\s?/gm, '')
  // unordered list markers
  s = s.replace(/^[\t ]*[-*+]\s+/gm, '')
  // ordered list markers
  s = s.replace(/^[\t ]*\d+\.\s+/gm, '')
  // horizontal rules (standalone lines of ---, ***, ___)
  s = s.replace(/^[-*_]{3,}\s*$/gm, '')
  // collapse whitespace
  s = s.replace(/\n/g, ' ')
  s = s.replace(/ {2,}/g, ' ')
  return s.trim()
}

export function summarizeMessageInput(input: MessagePayloadLike): string {
  const text = input.content.trim()
  if (text) {
    return text
  }

  const imageCount = normalizeMessageImages(input.images).length
  if (imageCount === 1) {
    return 'Shared an image'
  }

  if (imageCount > 1) {
    return `Shared ${imageCount} images`
  }

  return ''
}
