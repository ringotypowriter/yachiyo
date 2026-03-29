import { createServer, type Server } from 'node:net'
import { existsSync, unlinkSync } from 'node:fs'

export interface SendChannelInput {
  id: string
  message: string
}

export interface CommandSocketOptions {
  socketPath: string
  onNotification: (input: { title: string; body?: string }) => void
  onSendChannel: (input: SendChannelInput) => void
}

export interface CommandSocketHandle {
  close(): Promise<void>
}

interface TypedMessage {
  type?: string
  [key: string]: unknown
}

export function startCommandSocket(options: CommandSocketOptions): CommandSocketHandle {
  const { socketPath, onNotification, onSendChannel } = options

  // Clean up stale socket file from a previous crash
  if (existsSync(socketPath)) {
    unlinkSync(socketPath)
  }

  const server: Server = createServer((connection) => {
    let buffer = ''

    connection.setEncoding('utf-8')
    connection.on('data', (chunk: string) => {
      buffer += chunk
    })

    connection.on('end', () => {
      if (!buffer.trim()) return
      let message: TypedMessage
      try {
        message = JSON.parse(buffer) as TypedMessage
      } catch {
        return
      }

      const type = message.type

      // Backward compat: no type field + has title → notification
      if (!type) {
        if (typeof message.title === 'string' && message.title.trim()) {
          onNotification({ title: message.title, body: message.body as string | undefined })
        }
        return
      }

      if (type === 'notification') {
        if (typeof message.title !== 'string' || !message.title.trim()) return
        onNotification({ title: message.title, body: message.body as string | undefined })
        return
      }

      if (type === 'send-channel') {
        const id = message.id
        const msg = message.message
        if (typeof id !== 'string' || !id.trim()) return
        if (typeof msg !== 'string' || !msg.trim()) return
        onSendChannel({ id, message: msg })
      }
    })
  })

  server.listen(socketPath)

  return {
    async close(): Promise<void> {
      return new Promise((resolve) => {
        server.close(() => {
          if (existsSync(socketPath)) {
            try {
              unlinkSync(socketPath)
            } catch {
              // Best-effort cleanup
            }
          }
          resolve()
        })
      })
    }
  }
}
