import type { MessageImageRecord } from './protocol'

interface MessagePayloadLike {
  content: string
  images?: MessageImageRecord[]
  attachments?: { filename: string }[]
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
        ...(filename ? { filename } : {})
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
