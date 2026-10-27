import { connect } from 'node:net'
import { join } from 'node:path'

import { resolveYachiyoDataDir } from '@yachiyo/runtime/config/paths'
import { createRpcClient, type RpcClient } from '@yachiyo/shared/rpc/rpcClient'
import { createSocketRpcTransport } from '@yachiyo/shared/rpc/socketRpcTransport'

export interface HeadlessConnection {
  client: RpcClient
  closed: Promise<void>
}

export function resolveHeadlessSocketPath(home = resolveYachiyoDataDir()): string {
  return join(home, 'headless.sock')
}

export async function connectHeadless(
  socketPath = resolveHeadlessSocketPath()
): Promise<HeadlessConnection> {
  const socket = connect(socketPath)
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error('Timed out connecting to Yachiyo headless'))
    }, 5_000)
    socket.once('connect', () => {
      clearTimeout(timer)
      resolve()
    })
    socket.once('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      reject(
        ['ENOENT', 'ECONNREFUSED'].includes(error.code ?? '')
          ? new Error('Yachiyo headless is not running. Start it with yachiyo serve.')
          : error
      )
    })
  })
  const transport = createSocketRpcTransport(socket)
  const closed = new Promise<void>((resolve) => transport.onClose(resolve))
  return { client: createRpcClient(transport), closed }
}
