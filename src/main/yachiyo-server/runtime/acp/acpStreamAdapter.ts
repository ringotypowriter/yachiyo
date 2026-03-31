import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification
} from '@agentclientprotocol/sdk'

export interface AcpProgressCallbacks {
  onProgress?: (chunk: string) => void
}

export interface AcpYoloClient {
  requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse>
  sessionUpdate(params: SessionNotification): Promise<void>
}

export interface AcpStreamAdapter {
  yoloClient: AcpYoloClient
  onStderr(data: Buffer): void
  getLastMessageText(): string
}

export function createAcpStreamAdapter(callbacks: AcpProgressCallbacks): AcpStreamAdapter {
  let lastMessageText = ''
  let wasStreamingText = false
  let hadAnyProgress = false

  return {
    yoloClient: {
      requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
        const allowOption = params.options.find(
          (o) => o.kind === 'allow_once' || o.kind === 'allow_always'
        )
        if (allowOption) {
          return Promise.resolve({
            outcome: { outcome: 'selected', optionId: allowOption.optionId }
          })
        }
        return Promise.resolve({
          outcome: { outcome: 'selected', optionId: params.options[0].optionId }
        })
      },
      sessionUpdate(params: SessionNotification): Promise<void> {
        const update = params.update
        if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
          if (!wasStreamingText && hadAnyProgress) {
            callbacks.onProgress?.('\n')
          }
          wasStreamingText = true
          hadAnyProgress = true
          lastMessageText += update.content.text
          callbacks.onProgress?.(update.content.text)
        } else {
          wasStreamingText = false
        }
        return Promise.resolve()
      }
    },
    onStderr(data: Buffer): void {
      wasStreamingText = false
      hadAnyProgress = true
      callbacks.onProgress?.(data.toString('utf8'))
    },
    getLastMessageText(): string {
      return lastMessageText
    }
  }
}
