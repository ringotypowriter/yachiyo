import { connectAppServer } from '@yachiyo/runtime/appServer/connect'
import { appServerPort, readAppServerAddress } from '@yachiyo/runtime/appServer/discovery'
import { resolveYachiyoDataDir, resolveYachiyoSettingsPath } from '@yachiyo/runtime/config/paths'
import type { AppEventEnvelope, AppServerAddress } from '@yachiyo/shared/appServer/protocol'
import { type RpcCallOptions, type RpcClient } from '@yachiyo/shared/rpc/rpcClient'
import { app } from 'electron'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, realpath } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { unlockLegacyRemoteSecrets } from '../security/appServerSecrets.ts'
import { getProviderCredentialRuntimeStartupData } from '../security/providerCredentials.ts'

export interface DesktopAppServer {
  client: RpcClient
  ready(): Promise<void>
  createClientSession(origin: string): Promise<AppServerAddress>
  reconnect(): Promise<void>
  shutdown(): Promise<void>
  dispose(): void
}

async function waitForServerExit(pid: number): Promise<void> {
  const deadline = Date.now() + 10_000
  for (;;) {
    try {
      process.kill(pid, 0)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return
      throw error
    }
    if (Date.now() >= deadline) throw new Error('The previous app server is still shutting down')
    await delay(50)
  }
}

async function serverPortAvailable(home: string): Promise<boolean> {
  await mkdir(home, { recursive: true, mode: 0o700 })
  const port = appServerPort(await realpath(home))
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') resolve(false)
      else reject(error)
    })
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)))
  })
}

/** Owns a connection, not the daemon lifetime. Secrets travel only through its inherited stdin pipe. */
export function createDesktopAppServer(options: {
  entryPath: string
  isDev: boolean
  startupReady: Promise<void>
  mainServicesTarget: object
  onConnectionChange: (connected: boolean) => void
  onConnected: () => void
}): DesktopAppServer {
  const home = resolveYachiyoDataDir()
  const listeners = new Set<(event: unknown) => void>()
  let connection: Awaited<ReturnType<typeof connectAppServer>> | undefined
  let connecting: Promise<void> | undefined
  let disposed = false
  let retry: ReturnType<typeof setTimeout> | undefined
  let failures = 0

  const spawnServer = async (): Promise<void> => {
    await mkdir(home, { recursive: true, mode: 0o700 })
    const credentials = getProviderCredentialRuntimeStartupData(resolveYachiyoSettingsPath())
    const legacyRemoteSecrets = credentials.providerCredentialKey
      ? await unlockLegacyRemoteSecrets(home)
      : {}
    const log = await open(join(home, 'app-server.log'), 'a', 0o600)
    try {
      const child = spawn(process.execPath, [options.entryPath], {
        detached: true,
        windowsHide: true,
        stdio: ['pipe', log.fd, log.fd],
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',
          YACHIYO_HOME: home,
          YACHIYO_APP_VERSION: app.getVersion(),
          YACHIYO_RUNTIME_DEV: options.isDev ? '1' : '0',
          YACHIYO_RESOURCES_PATH: process.resourcesPath,
          YACHIYO_DEFAULT_APP: process.defaultApp ? '1' : '0'
        }
      })
      await new Promise<void>((resolve, reject) => {
        child.once('error', reject)
        child.once('spawn', resolve)
      })
      child.stdin!.on('error', (error) => console.error('[app-server] startup pipe failed:', error))
      child.stdin!.end(
        JSON.stringify({
          providerCredentialMode: credentials.providerCredentialMode,
          providerCredentialKey: credentials.providerCredentialKey?.toString('base64'),
          legacyRemoteSecrets
        })
      )
      child.unref()
    } finally {
      await log.close()
    }
  }

  const tryConnect = async (): Promise<Awaited<ReturnType<typeof connectAppServer>> | null> => {
    const address = await readAppServerAddress(home)
    if (!address) return null
    try {
      const connected = await connectAppServer(address, options.mainServicesTarget)
      try {
        const status = (await connected.client.call('server.status', [])) as {
          buildId?: string
          pid: number
        }
        const buildId = createHash('sha256')
          .update(await readFile(options.entryPath))
          .digest('hex')
        if (status.buildId && status.buildId !== buildId) {
          const owner = `build-change-${randomUUID()}`
          const runs = (await connected.client.call('closeRunAdmissionAndGetActiveRunIds', [
            owner
          ])) as string[]
          if (runs.length) {
            await connected.client.call('openRunAdmission', [owner])
            throw new Error(
              'The previous app server still has active tasks. Let them finish before opening the new build.'
            )
          }
          await connected.client.call('server.shutdown', [])
          connected.client.close()
          await waitForServerExit(status.pid)
          return null
        }
        return connected
      } catch (error) {
        connected.client.close()
        throw error
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ECONNREFUSED' || code === 'ECONNRESET') return null
      throw error
    }
  }

  const ready = (): Promise<void> => {
    if (disposed) return Promise.reject(new Error('Desktop app server connection closed'))
    if (connection) return Promise.resolve()
    if (connecting) return connecting
    connecting = (async () => {
      await options.startupReady
      let next = await tryConnect()
      if (!next) {
        let spawned = false
        const deadline = Date.now() + 30_000
        while (!next && Date.now() < deadline) {
          // A stopping daemon unpublishes before draining its jobs. Wait for its
          // storage lock rather than spawning a replacement that cannot bind.
          if (!spawned && (await serverPortAvailable(home))) {
            await spawnServer()
            spawned = true
          }
          await delay(100)
          next = await tryConnect()
        }
      }
      if (!next) throw new Error(`App server failed to start. See ${join(home, 'app-server.log')}`)
      if (disposed) {
        next.client.close()
        throw new Error('Desktop app server connection closed')
      }
      connection = next
      next.transport.onClose(() => {
        if (connection !== next) return
        connection = undefined
        options.onConnectionChange(false)
        if (!disposed && failures++ < 3) {
          retry = setTimeout(() => {
            void ready().catch((error) => console.error('[app-server] reconnect failed:', error))
          }, 1000)
        }
      })
      next.client.subscribe((value) => {
        for (const listener of listeners) listener((value as AppEventEnvelope).event)
      })
      await next.client.call('app.events', [])
      options.onConnectionChange(true)
      options.onConnected()
    })().finally(() => {
      connecting = undefined
    })
    return connecting
  }

  const client: RpcClient = {
    async call(method: string, args: unknown[], callOptions?: RpcCallOptions) {
      await ready()
      return connection!.client.call(method, args, callOptions)
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    close() {
      dispose()
    }
  }
  const dispose = (): void => {
    disposed = true
    if (retry) clearTimeout(retry)
    connection?.client.close()
    connection = undefined
    listeners.clear()
  }
  return {
    client,
    ready,
    dispose,
    async shutdown() {
      await ready()
      disposed = true
      if (retry) clearTimeout(retry)
      const current = connection!
      const status = (await current.client.call('server.status', [])) as { pid: number }
      await current.client.call('server.shutdown', [])
      current.client.close()
      await waitForServerExit(status.pid)
    },
    createClientSession: (origin) =>
      client.call('app.createClientSession', [{ origin }]) as Promise<AppServerAddress>,
    async reconnect() {
      failures = 0
      if (connection) await connection.client.call('app.detachHost', [])
      connection?.client.close()
      await ready()
    }
  }
}
