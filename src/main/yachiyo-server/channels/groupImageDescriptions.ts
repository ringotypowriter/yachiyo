import type { MessageImageRecord } from '../../../shared/yachiyo/protocol.ts'

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
    return
  }

  const i2t = input.server.getImageToTextService()
  await Promise.all(
    input.images.map(async (img) => {
      try {
        const result = await i2t.describe(img.dataUrl, input.text)
        if (result?.altText) {
          img.altText = result.altText
        }
      } catch (error) {
        console.warn(`[${input.logLabel}] image description failed:`, error)
      }
    })
  )
}
