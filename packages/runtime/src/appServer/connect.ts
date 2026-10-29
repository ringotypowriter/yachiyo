import { APP_SERVER_PROTOCOL, type AppServerAddress } from '@yachiyo/shared/appServer/protocol'
import { createRpcClient, type RpcClient } from '@yachiyo/shared/rpc/rpcClient'
import { serveRpcTarget } from '@yachiyo/shared/rpc/rpcServer'
import type { RpcTransport } from '@yachiyo/shared/rpc/rpcTransport'
import { createWebSocketRpcTransport } from '@yachiyo/shared/rpc/webSocketRpcTransport'
import { WebSocket } from 'ws'

export async function connectAppServer(
  address: AppServerAddress,
  hostTarget?: object
): Promise<{ client: RpcClient; transport: RpcTransport }> {
  const url = new URL(address.url)
  if (
    url.protocol !== 'ws:' ||
    url.hostname !== '127.0.0.1' ||
    address.protocol !== APP_SERVER_PROTOCOL
  ) {
    throw new Error('Invalid or incompatible local app server address')
  }
  const socket = new WebSocket(address.url, {
    handshakeTimeout: 5000,
    maxPayload: 64 * 1024 * 1024
  })
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })
  const transport = createWebSocketRpcTransport(socket)
  const client = createRpcClient(transport)
  const timeout = setTimeout(() => client.close(), 5000)
  try {
    await client.call('app.authenticate', [{ protocol: APP_SERVER_PROTOCOL, token: address.token }])
    if (hostTarget) {
      const dispose = serveRpcTarget({ transport, target: hostTarget })
      transport.onClose(dispose)
      await client.call('app.attachHost', [])
    }
    return { client, transport }
  } catch (error) {
    client.close()
    throw error
  } finally {
    clearTimeout(timeout)
  }
}
