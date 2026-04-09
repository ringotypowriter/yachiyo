import { createServer, connect, type Server } from 'node:net'
import { existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'

export interface SendChannelInput {
  id: string
  message: string
}

export interface UpdateChannelGroupStatusInput {
  id: string
  status: 'pending' | 'approved' | 'blocked'
}

export interface UpdateChannelGroupLabelInput {
  id: string
  label: string
}

export interface CommandSocketOptions {
  socketPath: string
  onNotification: (input: { title: string; body?: string }) => void
  onSendChannel: (input: SendChannelInput) => void
  onUpdateChannelGroupStatus: (input: UpdateChannelGroupStatusInput) => void
  onUpdateChannelGroupLabel: (input: UpdateChannelGroupLabelInput) => void
  onError?: (error: Error) => void
}

export interface CommandSocketHandle {
  close(): Promise<void>
  healthCheck(timeoutMs?: number): Promise<boolean>
}

interface TypedMessage {
  type?: string
  [key: string]: unknown
}

export function startCommandSocket(options: CommandSocketOptions): CommandSocketHandle {
  const {
    socketPath,
    onNotification,
    onSendChannel,
    onUpdateChannelGroupStatus,
    onUpdateChannelGroupLabel,
    onError
  } = options
  let closed = false

  // Clean up stale socket file from a previous crash
  mkdirSync(dirname(socketPath), { recursive: true })
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
        return
      }

      if (type === 'update-channel-group-status') {
        const id = message.id
        const status = message.status
        if (typeof id !== 'string' || !id.trim()) return
        if (status !== 'pending' && status !== 'approved' && status !== 'blocked') return
        onUpdateChannelGroupStatus({ id, status })
        return
      }

      if (type === 'update-channel-group-label') {
        const id = message.id
        const label = message.label
        if (typeof id !== 'string' || !id.trim()) return
        if (typeof label !== 'string') return
        onUpdateChannelGroupLabel({ id, label })
      }
    })
  })

  server.on('error', (error) => {
    onError?.(error)
  })

  server.on('close', () => {
    closed = true
  })

  server.listen(socketPath)

  return {
    async healthCheck(timeoutMs = 1_000): Promise<boolean> {
      if (closed || !server.listening) {
        return false
      }

      return new Promise((resolve) => {
        let settled = false
        const client = connect(socketPath)
        const finish = (healthy: boolean): void => {
          if (settled) {
            return
          }
          settled = true
          clearTimeout(timeoutHandle)
          client.removeAllListeners()
          if (!client.destroyed) {
            client.destroy()
          }
          resolve(healthy)
        }

        const timeoutHandle = setTimeout(() => finish(false), timeoutMs)

        client.once('connect', () => finish(true))
        client.once('error', () => finish(false))
      })
    },
    async close(): Promise<void> {
      return new Promise((resolve) => {
        closed = true
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
