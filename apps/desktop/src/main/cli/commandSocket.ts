import { createServer, connect as connectSocket, type Server, type Socket } from 'node:net'
import { existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'
import type { CommandEndpoint } from '@yachiyo/runtime/config/commandEndpoint'
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
  afterReply?: () => void | Promise<void>
  onReplyFailure?: () => void | Promise<void>
}

export interface AppUpdateReplyConnection {
  once(event: 'finish', listener: () => void): unknown
  end(payload: string): unknown
}

export function createAppUpdateReplyFinalizer(input: {
  afterReply?: () => void | Promise<void>
  onReplyFailure?: () => void | Promise<void>
  onError?: (error: Error) => void
}): { complete(): void; fail(): void } {
  let finalized = false
  return {
    complete(): void {
      if (finalized) return
      finalized = true
      if (!input.afterReply) return
      try {
        void Promise.resolve(input.afterReply()).catch((error) => {
          input.onError?.(error instanceof Error ? error : new Error(String(error)))
        })
      } catch (error) {
        input.onError?.(error instanceof Error ? error : new Error(String(error)))
      }
    },
    fail(): void {
      if (finalized) return
      finalized = true
      if (!input.onReplyFailure) return
      void Promise.resolve()
        .then(input.onReplyFailure)
        .catch((error) => {
          input.onError?.(error instanceof Error ? error : new Error(String(error)))
        })
    }
  }
}

export function writeAppUpdateReply(
  connection: AppUpdateReplyConnection,
  response: AppUpdateCommandResponse,
  finalizer: { complete(): void }
): void {
  connection.once('finish', finalizer.complete)
  connection.end(JSON.stringify(response))
}

export type AppUpdateCommandInput = Omit<AppUpdateCommandRequest, 'type'>

export interface CommandSocketOptions {
  endpoint?: CommandEndpoint
  /** Legacy test/dev input. Production callers use `endpoint`. */
  socketPath?: string
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

export interface CommandEndpointFileSystem {
  existsSync(path: string): boolean
  mkdirSync(path: string, options: { recursive: boolean }): void
  unlinkSync(path: string): void
}

const commandEndpointFileSystem: CommandEndpointFileSystem = {
  existsSync,
  mkdirSync,
  unlinkSync
}

export function prepareCommandEndpoint(
  endpoint: CommandEndpoint,
  fileSystem: CommandEndpointFileSystem = commandEndpointFileSystem
): void {
  if (endpoint.kind !== 'unix-socket') return
  fileSystem.mkdirSync(dirname(endpoint.address), { recursive: true })
  if (fileSystem.existsSync(endpoint.address)) {
    fileSystem.unlinkSync(endpoint.address)
  }
}

export function cleanupCommandEndpoint(
  endpoint: CommandEndpoint,
  fileSystem: CommandEndpointFileSystem = commandEndpointFileSystem
): void {
  if (endpoint.kind !== 'unix-socket' || !fileSystem.existsSync(endpoint.address)) return
  fileSystem.unlinkSync(endpoint.address)
}

interface CommandEndpointProbeSocket {
  destroyed?: boolean
  destroy(): void
  end(): void
  once(event: string, listener: (...args: unknown[]) => void): this
  removeAllListeners(): this
}

export function probeCommandEndpoint(
  endpoint: CommandEndpoint,
  options: {
    timeoutMs?: number
    connect?: (address: string, onConnect: () => void) => CommandEndpointProbeSocket
  } = {}
): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? 1_000
  const connect =
    options.connect ??
    ((address: string, onConnect: () => void): Socket => connectSocket(address, onConnect))

  return new Promise((resolve) => {
    let settled = false
    const timeoutHandle = setTimeout(() => finish(false), timeoutMs)
    const finish = (healthy: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timeoutHandle)
      socket.removeAllListeners()
      if (!socket.destroyed) {
        if (healthy) socket.end()
        else socket.destroy()
      }
      resolve(healthy)
    }

    const socket = connect(endpoint.address, () => finish(true))
    socket.once('error', () => finish(false))
  })
}

export interface CommandSocketRestartPolicy {
  nextDelay(): number | null
  reset(): void
}

export function createCommandSocketRestartPolicy(options: {
  initialDelayMs: number
  maxAttempts: number
}): CommandSocketRestartPolicy {
  let attempts = 0
  return {
    nextDelay(): number | null {
      if (attempts >= options.maxAttempts) return null
      const delay = options.initialDelayMs * 2 ** attempts
      attempts += 1
      return delay
    },
    reset(): void {
      attempts = 0
    }
  }
}

function resolveCommandSocketEndpoint(options: CommandSocketOptions): CommandEndpoint {
  if (options.endpoint) return options.endpoint
  if (options.socketPath) return { kind: 'unix-socket', address: options.socketPath }
  throw new Error('Command socket endpoint is required.')
}

export function startCommandSocket(options: CommandSocketOptions): CommandSocketHandle {
  const {
    onNotification,
    onSendChannel,
    onUpdateChannelGroupStatus,
    onUpdateChannelGroupLabel,
    onMarkThreadReviewed,
    onAppUpdate,
    onError
  } = options
  const endpoint = resolveCommandSocketEndpoint(options)
  let closed = false

  prepareCommandEndpoint(endpoint)

  const server: Server = createServer({ allowHalfOpen: true }, (connection) => {
    let buffer = ''
    let requestHandled = false
    let transportClosed = false
    let failPendingReply: (() => void) | undefined

    const handleRequest = (): void => {
      if (requestHandled) return
      requestHandled = true
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
          .then(({ result, afterReply, onReplyFailure }) => {
            const response: AppUpdateCommandResponse = { ok: true, result }
            const finalizer = createAppUpdateReplyFinalizer({
              afterReply,
              onReplyFailure,
              onError
            })
            failPendingReply = finalizer.fail

            if (transportClosed || connection.destroyed) {
              finalizer.fail()
              return
            }

            writeAppUpdateReply(connection, response, finalizer)
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
    }

    connection.setEncoding('utf-8')
    connection.on('error', () => {
      transportClosed = true
      failPendingReply?.()
    })
    connection.on('close', () => {
      transportClosed = true
      failPendingReply?.()
    })
    connection.on('data', (chunk: string) => {
      buffer += chunk
      if (buffer.endsWith('\n')) handleRequest()
    })
    connection.on('end', () => {
      if (!requestHandled) {
        handleRequest()
        return
      }
      transportClosed = true
      failPendingReply?.()
      if (!connection.destroyed) connection.destroy()
    })
  })

  server.on('error', (error) => {
    onError?.(error)
  })

  server.on('close', () => {
    closed = true
  })

  server.listen(endpoint.address)

  return {
    async healthCheck(timeoutMs = 1_000): Promise<boolean> {
      if (closed || !server.listening) {
        return false
      }

      return probeCommandEndpoint(endpoint, { timeoutMs })
    },
    async close(): Promise<void> {
      return new Promise((resolve) => {
        closed = true
        const finish = (): void => {
          try {
            cleanupCommandEndpoint(endpoint)
          } catch {
            // Best-effort cleanup
          }
          resolve()
        }
        try {
          server.close(finish)
        } catch {
          finish()
        }
      })
    }
  }
}
