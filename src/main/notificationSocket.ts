import { createServer, type Server } from 'node:net'
import { existsSync, unlinkSync } from 'node:fs'

export interface NotificationSocketOptions {
  socketPath: string
  onNotification: (input: { title: string; body?: string }) => void
}

export interface NotificationSocketHandle {
  close(): Promise<void>
}

export function startNotificationSocket(
  options: NotificationSocketOptions
): NotificationSocketHandle {
  const { socketPath, onNotification } = options

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
      try {
        const message = JSON.parse(buffer) as { title?: string; body?: string }
        if (typeof message.title !== 'string' || !message.title.trim()) {
          connection.destroy()
          return
        }
        onNotification({ title: message.title, body: message.body })
      } catch {
        // Malformed JSON — silently ignore
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
