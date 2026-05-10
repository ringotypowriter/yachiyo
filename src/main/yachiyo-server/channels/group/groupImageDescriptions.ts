import type { MessageImageRecord } from '../../../../shared/yachiyo/protocol.ts'

interface GroupImageDescriptionServer {
  getChannelsConfig(): {
    imageToText?: {
      enabled?: boolean
    }
  }
  getImageToTextService(): {
    describe(dataUrl: string, caption?: string): Promise<{ altText: string } | null>
  }
}

export interface DescribeGroupImagesInput {
  server: GroupImageDescriptionServer
  text: string
  images: MessageImageRecord[]
  logLabel: string
}

export async function describeGroupImages(input: DescribeGroupImagesInput): Promise<void> {
  if (input.images.length === 0) {
    return
  }

  const channelsConfig = input.server.getChannelsConfig()
  if (channelsConfig.imageToText?.enabled !== true) {
    input.images.length = 0
    return
  }

  const i2t = input.server.getImageToTextService()
  const describedImages = await Promise.all(
    input.images.map(async (img): Promise<MessageImageRecord | null> => {
      try {
        const result = await i2t.describe(img.dataUrl, input.text)
        const altText = result?.altText.trim()
        if (altText) {
          return { ...img, altText }
        }
      } catch (error) {
        console.warn(`[${input.logLabel}] image description failed:`, error)
      }
      return null
    })
  )
  input.images.splice(
    0,
    input.images.length,
    ...describedImages.filter((img): img is MessageImageRecord => img !== null)
  )
}
