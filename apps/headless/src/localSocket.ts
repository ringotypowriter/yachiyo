import { connect, createServer, type Socket } from 'node:net'
import { chmod, lstat, unlink } from 'node:fs/promises'

import { createSocketRpcTransport } from '@yachiyo/shared/rpc/socketRpcTransport'
import { serveRpcTarget } from '@yachiyo/shared/rpc/rpcServer'
import type { YachiyoServerEvent } from '@yachiyo/shared/protocol'

export async function isSocketRunning(path: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = connect(path)
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error(`Timed out probing ${path}; refusing to replace it`))
    }, 1_000)
    socket.once('connect', () => {
      clearTimeout(timer)
      socket.destroy()
      resolve(true)
    })
    socket.once('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      if (error.code === 'ENOENT' || error.code === 'ECONNREFUSED') resolve(false)
      else reject(error)
    })
  })
}

async function removeStaleSocket(path: string): Promise<void> {
  let info
  try {
    info = await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  if (!info.isSocket() || info.uid !== process.getuid?.()) {
    throw new Error(`Refusing to replace a non-socket or another user's socket at ${path}`)
  }
  if (await isSocketRunning(path)) throw new Error('Yachiyo headless is already running')
  const current = await lstat(path)
  if (current.ino !== info.ino)
    throw new Error('The socket changed during startup; retry after the other process exits')
  await unlink(path)
}

export async function listenLocalSocket(input: {
  path: string
  target: object
  subscribe: (listener: (event: YachiyoServerEvent) => void) => () => void
}): Promise<{ close(): Promise<void> }> {
  await removeStaleSocket(input.path)
  const sockets = new Set<Socket>()
  const server = createServer((socket) => {
    sockets.add(socket)
    let threadId: string | null = null
    const target = Object.assign(Object.create(null), input.target, {
      watchThread(id: string): void {
        if (typeof id !== 'string' || !id) throw new Error('A thread ID is required')
        threadId = id
      }
    })
    const transport = createSocketRpcTransport(socket)
    const dispose = serveRpcTarget({
      transport,
      target,
      subscribe: (listener) =>
        input.subscribe((event) => {
          if ('threadId' in event && event.threadId === threadId) {
            try {
              listener(event)
            } catch {
              // A slow or oversized client stream must not fail the assistant's run.
              transport.close()
            }
          }
        })
    })
    socket.once('close', () => {
      dispose()
      sockets.delete(socket)
    })
  })
  await new Promise<void>((resolve, reject) => {
    const fail = (error: Error): void => {
      server.close()
      reject(error)
    }
    server.once('error', fail)
    server.listen(input.path, () => {
      server.off('error', fail)
      resolve()
    })
  })
  try {
    await chmod(input.path, 0o600)
  } catch (error) {
    server.close()
    throw error
  }
  return {
    async close(): Promise<void> {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
    }
  }
}
