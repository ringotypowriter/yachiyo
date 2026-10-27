import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  createSqliteYachiyoServer,
  type YachiyoServer
} from '@yachiyo/runtime/app/host/YachiyoServer'
import type { SqliteYachiyoServerOptions } from '@yachiyo/runtime/app/host/options'
import {
  createRuntimeLiveServices,
  type RuntimeLiveServices
} from '@yachiyo/runtime/app/host/runtimeLiveServices'
import { createJotdownStore } from '@yachiyo/runtime/services/jotdownStore'
import { NativeProcessBroker } from '@yachiyo/runtime/services/processBroker/nativeProcessBroker'
import { RelayActivation } from '@yachiyo/runtime/remote/relayActivation'
import type { RemoteCommandRequest } from '@yachiyo/shared/remote/command'
import type { YachiyoServerEvent } from '@yachiyo/shared/protocol'
import { resolveHeadlessSocketPath } from '@yachiyo/cli/services/headless'
import { createHeadlessProviderVault, createHeadlessSecretBox } from './credentials.ts'
import { listenLocalSocket, isSocketRunning } from './localSocket.ts'
import { startHeadlessRemote, type HeadlessRemote } from './remote.ts'

export interface HeadlessHostOptions {
  home: string
  masterKey: Uint8Array
  version: string
  log: (line: string) => void
  /** Test hosts use in-memory storage while exercising the same sockets and lifecycle. */
  createServer?: (options: SqliteYachiyoServerOptions) => YachiyoServer
  liveServices?: boolean
  resourcesDir?: string
}

export interface HeadlessHost {
  server: YachiyoServer
  close(): Promise<void>
}

export async function startHeadlessHost(options: HeadlessHostOptions): Promise<HeadlessHost> {
  const { home, masterKey, log } = options
  await mkdir(home, { recursive: true, mode: 0o700 })
  if (await isSocketRunning(join(home, 'yachiyo.sock'))) {
    throw new Error(
      'The desktop app is using this YACHIYO_HOME. Stop it or choose a separate data directory.'
    )
  }
  const secretBox = createHeadlessSecretBox(masterKey)
  const vault = createHeadlessProviderVault(home, masterKey)
  let server: YachiyoServer | null = null
  let live: RuntimeLiveServices | null = null
  let remote: HeadlessRemote | null = null
  let started = false
  const subscribers = new Set<(event: YachiyoServerEvent) => void>()
  const ready = (): YachiyoServer => {
    if (!server || !started) throw new Error('Yachiyo is starting')
    return server
  }
  const target = Object.create(null) as Record<string, (...args: never[]) => unknown>
  const methods = [
    'getConfig',
    'saveConfig',
    'upsertProvider',
    'setDefaultProvider',
    'fetchProviderModels',
    'createThread',
    'sendChat',
    'cancelRun',
    'answerToolQuestion'
  ] as const
  for (const name of methods) {
    target[name] = (...args: never[]) => Reflect.apply(ready()[name], ready(), args)
  }
  Object.assign(target, {
    pairRemote: () => {
      if (!remote) throw new Error('Remote is starting')
      return remote.pair()
    },
    remoteCommand: async (request: RemoteCommandRequest) => {
      if (!remote) throw new Error('Remote is starting')
      switch (request.action) {
        case 'status':
          return remote.status()
        case 'pairings-list':
          return remote.list()
        case 'pairings-revoke':
          return { revoked: await remote.revoke(request.pairingId) }
        case 'relay-activate': {
          const activation = new RelayActivation(join(home, 'remote'), secretBox)
          return activation.redeem(request.code)
        }
        default:
          throw new Error(
            'Headless uses an external TLS proxy or relay. Manage it outside Yachiyo.'
          )
      }
    },
    sendNotification: (input: { title: string; body?: string }) =>
      log(`${input.title}: ${input.body ?? ''}`),
    sendChannelMessage: (input: never) => {
      ready()
      if (!live) throw new Error('Channel services are unavailable')
      return live.rpcOps['host.sendChannelMessage'](input)
    },
    updateChannelGroup: (input: never) => {
      ready()
      if (!live) throw new Error('Channel services are unavailable')
      return live.rpcOps['host.updateChannelGroupAndNotify'](input)
    },
    markThreadReviewed: (input: { threadId: string }) => ready().markThreadReviewed(input)
  })
  const socket = await listenLocalSocket({
    path: resolveHeadlessSocketPath(home),
    target,
    subscribe(listener) {
      subscribers.add(listener)
      return () => subscribers.delete(listener)
    }
  })
  let unsubscribe: (() => void) | undefined
  let closed = false
  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    started = false
    unsubscribe?.()
    subscribers.clear()
    // Close clients first; a stopped daemon must never leave a CLI waiting on a run.
    await socket.close()
    try {
      await remote?.stop()
    } finally {
      if (live) await live.shutdown()
      else await server?.close()
    }
  }
  try {
    const processBroker = new NativeProcessBroker(
      options.resourcesDir ? { binaryPath: join(options.resourcesDir, 'bin/process-host') } : {}
    )
    try {
      server = (options.createServer ?? createSqliteYachiyoServer)({
        dbPath: join(home, 'yachiyo.sqlite'),
        settingsPath: join(home, 'config.toml'),
        seedPresetProviders: true,
        providerCredentialVault: vault,
        fetchImpl: globalThis.fetch,
        webExternalFetchImpl: globalThis.fetch,
        activityTracker: { finalizeAndConsume: () => null },
        unavailableTools: ['useBrowser', 'webSearch', 'renderUi', 'createRemotePairingQr'],
        processBroker,
        jotdownStore: createJotdownStore(join(home, 'jotdowns')),
        ...(options.resourcesDir
          ? {
              jsReplWorkerPath: pathToFileURL(join(options.resourcesDir, 'jsReplWorker.mjs')),
              pyReplRunnerPath: join(options.resourcesDir, 'pyReplRunner.py')
            }
          : {})
      })
    } catch (error) {
      await processBroker.close()
      throw error
    }
    unsubscribe = server.subscribe((event) => {
      for (const listener of subscribers) listener(event)
    })
    server.getTtlReaper().start()
    remote = await startHeadlessRemote({ home, server, secretBox, version: options.version, log })
    if (options.liveServices !== false) {
      live = createRuntimeLiveServices({
        server,
        showNotification: ({ title, body }) => log(`${title}: ${body ?? ''}`),
        updateReceiptLease: {
          // Service-manager upgrades do not create desktop update receipts.
          claim: async () => undefined,
          ack: async () => {},
          release: async () => {}
        },
        tempWorkspaceDir: join(home, 'temp-workspace'),
        enableSchedules: true,
        enableChannels: true
      })
      await live.start()
    }
    started = true
    return { server, close }
  } catch (error) {
    await close()
    throw error
  }
}
