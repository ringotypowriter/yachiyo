import { connect } from 'node:net'

import type { RemoteCommandRequest, RemoteCommandResponse } from '@yachiyo/shared/remote/command'

const REMOTE_REQUEST_TIMEOUT_MS = 60_000

/** Sends one `type: 'remote'` request to the running app over the command socket. */
export function defaultRequestRemote(
  socketPath: string,
  request: RemoteCommandRequest
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let response = ''
    let settled = false
    const client = connect(socketPath, () => {
      const message = JSON.stringify({ type: 'remote', ...request })
      if (process.platform === 'win32') client.write(`${message}\n`)
      else client.end(message)
    })
    const finish = (error?: Error, result?: unknown): void => {
      if (settled) return
      settled = true
      client.removeAllListeners()
      if (!client.destroyed) client.destroy()
      if (error) reject(error)
      else resolve(result)
    }
    client.setEncoding('utf8')
    client.setTimeout(REMOTE_REQUEST_TIMEOUT_MS)
    client.on('data', (chunk: string) => {
      response += chunk
    })
    client.on('end', () => {
      let parsed: RemoteCommandResponse
      try {
        parsed = JSON.parse(response) as RemoteCommandResponse
      } catch {
        finish(new Error('Yachiyo app returned an invalid remote response.'))
        return
      }
      if (!parsed.ok) finish(new Error(parsed.error))
      else finish(undefined, parsed.result)
    })
    client.on('timeout', () => finish(new Error('Timed out waiting for the Yachiyo app.')))
    client.on('error', (error) => {
      const code = (error as NodeJS.ErrnoException).code
      finish(
        code === 'ENOENT' || code === 'ECONNREFUSED'
          ? new Error('Yachiyo app is not running. Start the app first.')
          : error
      )
    })
  })
}
