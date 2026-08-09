import { connect } from 'node:net'
import type { ChannelGroupStatus } from '@yachiyo/shared/protocol'

const APP_NOT_RUNNING_CODES = new Set(['ENOENT', 'ECONNREFUSED', 'EPIPE', 'ERROR_PIPE_BUSY'])

export function normalizeSocketTransportError(error: Error): Error {
  const code = (error as NodeJS.ErrnoException).code
  return code && APP_NOT_RUNNING_CODES.has(code)
    ? new Error('Yachiyo app is not running. Start the app first.')
    : error
}

export function defaultSendNotification(
  socketPath: string,
  payload: { title: string; body?: string }
): Promise<void> {
  return new Promise((resolve, reject) => {
    const client = connect(socketPath, () => {
      client.end(JSON.stringify(payload))
    })
    client.on('close', () => resolve())
    client.on('error', (err) => {
      reject(normalizeSocketTransportError(err))
    })
  })
}

export function defaultSendChannel(
  socketPath: string,
  payload: { type: 'send-channel'; id: string; message: string }
): Promise<void> {
  return new Promise((resolve, reject) => {
    const client = connect(socketPath, () => {
      client.end(JSON.stringify(payload))
    })
    client.on('close', () => resolve())
    client.on('error', (err) => {
      reject(normalizeSocketTransportError(err))
    })
  })
}

export function defaultSendChannelGroupStatus(
  socketPath: string,
  payload: {
    type: 'update-channel-group-status'
    id: string
    status: ChannelGroupStatus
  }
): Promise<void> {
  return new Promise((resolve, reject) => {
    const client = connect(socketPath, () => {
      client.end(JSON.stringify(payload))
    })
    client.on('close', () => resolve())
    client.on('error', (err) => {
      reject(normalizeSocketTransportError(err))
    })
  })
}

export function defaultSendChannelGroupLabel(
  socketPath: string,
  payload: {
    type: 'update-channel-group-label'
    id: string
    label: string
  }
): Promise<void> {
  return new Promise((resolve, reject) => {
    const client = connect(socketPath, () => {
      client.end(JSON.stringify(payload))
    })
    client.on('close', () => resolve())
    client.on('error', (err) => {
      reject(normalizeSocketTransportError(err))
    })
  })
}

export function defaultSendMarkThreadReviewed(
  socketPath: string,
  payload: { type: 'mark-thread-reviewed'; threadId: string }
): Promise<void> {
  return new Promise((resolve, reject) => {
    const client = connect(socketPath, () => {
      client.end(JSON.stringify(payload))
    })
    client.on('close', () => resolve())
    client.on('error', (err) => {
      if (normalizeSocketTransportError(err) !== err) {
        // App not running — best-effort, silently resolve
        resolve()
      } else {
        reject(err)
      }
    })
  })
}
