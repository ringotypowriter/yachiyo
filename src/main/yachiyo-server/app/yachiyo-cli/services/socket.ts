import { connect } from 'node:net'
import type { ChannelGroupStatus } from '../../../../../shared/yachiyo/protocol.ts'

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
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ECONNREFUSED') {
        reject(new Error('Yachiyo app is not running. Start the app first to send notifications.'))
      } else {
        reject(err)
      }
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
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ECONNREFUSED') {
        reject(new Error('Yachiyo app is not running. Start the app first.'))
      } else {
        reject(err)
      }
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
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ECONNREFUSED') {
        reject(new Error('Yachiyo app is not running. Start the app first.'))
      } else {
        reject(err)
      }
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
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ECONNREFUSED') {
        reject(new Error('Yachiyo app is not running. Start the app first.'))
      } else {
        reject(err)
      }
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
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ECONNREFUSED') {
        // App not running — best-effort, silently resolve
        resolve()
      } else {
        reject(err)
      }
    })
  })
}
