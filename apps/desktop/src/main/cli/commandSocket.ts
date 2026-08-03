import { createServer, connect, type Server } from 'node:net'
import { existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'
import type {
  AppUpdateCommandRequest,
  AppUpdateCommandResult,
  AppUpdateCommandResponse
} from '@yachiyo/shared/appUpdate'

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

export interface MarkThreadReviewedInput {
  threadId: string
}

export interface AppUpdateCommandReply {
  result: AppUpdateCommandResult
  afterReply?: () => void
}

export type AppUpdateCommandInput = Omit<AppUpdateCommandRequest, 'type'>

export interface CommandSocketOptions {
  socketPath: string
  onNotification: (input: { title: string; body?: string }) => void
  onSendChannel: (input: SendChannelInput) => void
  onUpdateChannelGroupStatus: (input: UpdateChannelGroupStatusInput) => void
  onUpdateChannelGroupLabel: (input: UpdateChannelGroupLabelInput) => void
  onMarkThreadReviewed: (input: MarkThreadReviewedInput) => void
  onAppUpdate?: (input: AppUpdateCommandInput) => Promise<AppUpdateCommandReply>
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
    onMarkThreadReviewed,
    onAppUpdate,
    onError
  } = options
  let closed = false

  // Clean up stale socket file from a previous crash
  mkdirSync(dirname(socketPath), { recursive: true })
  if (existsSync(socketPath)) {
    unlinkSync(socketPath)
  }

  const server: Server = createServer({ allowHalfOpen: true }, (connection) => {
    let buffer = ''

    connection.setEncoding('utf-8')
    connection.on('data', (chunk: string) => {
      buffer += chunk
    })

    connection.on('end', () => {
      const close = (): void => {
        connection.end()
      }
      if (!buffer.trim()) {
        close()
        return
      }
      let message: TypedMessage
      try {
        message = JSON.parse(buffer) as TypedMessage
      } catch {
        close()
        return
      }

      const type = message.type

      // Backward compat: no type field + has title → notification
      if (!type) {
        if (typeof message.title === 'string' && message.title.trim()) {
          onNotification({ title: message.title, body: message.body as string | undefined })
        }
        close()
        return
      }

      if (type === 'notification') {
        if (typeof message.title !== 'string' || !message.title.trim()) {
          close()
          return
        }
        onNotification({ title: message.title, body: message.body as string | undefined })
        close()
        return
      }

      if (type === 'send-channel') {
        const id = message.id
        const msg = message.message
        if (typeof id !== 'string' || !id.trim()) {
          close()
          return
        }
        if (typeof msg !== 'string' || !msg.trim()) {
          close()
          return
        }
        onSendChannel({ id, message: msg })
        close()
        return
      }

      if (type === 'update-channel-group-status') {
        const id = message.id
        const status = message.status
        if (typeof id !== 'string' || !id.trim()) {
          close()
          return
        }
        if (status !== 'pending' && status !== 'approved' && status !== 'blocked') {
          close()
          return
        }
        onUpdateChannelGroupStatus({ id, status })
        close()
        return
      }

      if (type === 'update-channel-group-label') {
        const id = message.id
        const label = message.label
        if (typeof id !== 'string' || !id.trim()) {
          close()
          return
        }
        if (typeof label !== 'string') {
          close()
          return
        }
        onUpdateChannelGroupLabel({ id, label })
        close()
        return
      }

      if (type === 'mark-thread-reviewed') {
        const threadId = message.threadId
        if (typeof threadId !== 'string' || !threadId.trim()) {
          close()
          return
        }
        onMarkThreadReviewed({ threadId })
        close()
        return
      }

      if (type === 'app-update') {
        const action = message.action
        const initiatorRunId = message.initiatorRunId
        if (
          !onAppUpdate ||
          (action !== 'status' &&
            action !== 'prepare' &&
            action !== 'install' &&
            action !== 'snapshot') ||
          (initiatorRunId !== undefined &&
            (typeof initiatorRunId !== 'string' || !initiatorRunId.trim())) ||
          (action === 'install' && typeof message.force !== 'boolean')
        ) {
          const response: AppUpdateCommandResponse = {
            ok: false,
            error: 'Unsupported app update command.'
          }
          connection.end(JSON.stringify(response))
          return
        }

        const input: AppUpdateCommandInput = {
          action,
          ...(action === 'install' ? { force: message.force as boolean } : {}),
          ...(typeof initiatorRunId === 'string' ? { initiatorRunId } : {})
        }

        void onAppUpdate(input)
          .then(({ result, afterReply }) => {
            const response: AppUpdateCommandResponse = { ok: true, result }
            connection.end(JSON.stringify(response), () => {
              if (!afterReply) return
              try {
                afterReply()
              } catch (error) {
                onError?.(error instanceof Error ? error : new Error(String(error)))
              }
            })
          })
          .catch((error) => {
            const response: AppUpdateCommandResponse = {
              ok: false,
              error: error instanceof Error ? error.message : String(error)
            }
            connection.end(JSON.stringify(response))
          })
        return
      }

      close()
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
