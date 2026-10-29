import type { AppServerAddress } from '@yachiyo/shared/appServer/protocol'
import type { AppUpdateCommandResult } from '@yachiyo/shared/appUpdate'
import { DEFAULT_REMOTE_CONFIG, type YachiyoServerEvent } from '@yachiyo/shared/protocol'
import type { RemoteCommandRequest } from '@yachiyo/shared/remote/command'
import { mkdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { createRpcActivitySummarySource } from '../activity/activityTrackerRpcBridge.ts'
import { createSqliteYachiyoServer, type YachiyoServer } from '../app/host/YachiyoServer.ts'
import type { SqliteYachiyoServerOptions } from '../app/host/options.ts'
import {
  createRuntimeLiveServices,
  type RuntimeLiveServices
} from '../app/host/runtimeLiveServices.ts'
import { resolveCommandEndpoint } from '../config/commandEndpoint.ts'
import type { SecretBox } from '../remote/pairingStore.ts'
import { createUnavailableRemoteBinding } from '../remote/remoteCredentialMode.ts'
import { createRpcBrowserAutomationBackend } from '../services/browserAutomation/browserAutomationRpcBridge.ts'
import { createJotdownStore } from '../services/jotdownStore.ts'
import { NativeProcessBroker } from '../services/processBroker/nativeProcessBroker.ts'
import { createRpcWebExternalFetch } from '../services/webExternalFetchRpcBridge.ts'
import { createRpcBrowserSearchPageFactory } from '../services/webSearch/browserSearchPageFactoryRpcBridge.ts'
import type { ProviderCredentialVault } from '../settings/providerCredentialVault.ts'
import { isSocketRunning, listenLocalSocket } from './cliSocket.ts'
import { startCommandSocket, type CommandSocketHandle } from './commandSocket.ts'
import { appServerPort, publishAppServerAddress } from './discovery.ts'
import { AppHostBridge } from './hostBridge.ts'
import { listenAppServer, type AppServerListener } from './listener.ts'
import { createAppRpcTarget } from './methods.ts'
import { createAppRemoteBinding, type AppRemoteBinding } from './remoteBinding.ts'

export interface AppServerOptions {
  home: string
  version: string
  buildId?: string
  vault: ProviderCredentialVault
  secretBox?: SecretBox
  developmentMode?: boolean
  nativeHost?: boolean
  liveServices?: boolean
  commandSocket?: boolean
  fetchImpl?: typeof fetch
  jsReplWorkerPath?: string | URL
  pyReplRunnerPath?: string | URL
  processHostPath?: string
  origins?: string[]
  log: (line: string) => void
  createServer?: (options: SqliteYachiyoServerOptions) => YachiyoServer
  onShutdown?: () => void
}

export interface RunningAppServer {
  server: YachiyoServer
  address: AppServerAddress
  host: AppHostBridge
  close(): Promise<void>
}

export async function startAppServer(options: AppServerOptions): Promise<RunningAppServer> {
  await mkdir(options.home, { recursive: true, mode: 0o700 })
  const home = await realpath(options.home)
  // Older desktop versions own SQLite without the app-server listener.
  if (process.platform !== 'win32' && (await isSocketRunning(join(home, 'yachiyo.sock')))) {
    throw new Error(
      'An older desktop instance is using this data directory. Quit it before starting the app server.'
    )
  }
  const host = new AppHostBridge()
  let server: YachiyoServer | undefined
  let live: RuntimeLiveServices | undefined
  let remote: AppRemoteBinding | undefined
  let listener: AppServerListener | undefined
  let cli: { close(): Promise<void> } | undefined
  let commandSocket: CommandSocketHandle | undefined
  let unpublish: (() => Promise<void>) | undefined
  let unsubscribe: (() => void) | undefined
  let closing: Promise<void> | undefined
  const subscribers = new Set<(event: YachiyoServerEvent) => void>()
  const subscribe = (fn: (event: YachiyoServerEvent) => void): (() => void) => {
    subscribers.add(fn)
    return () => subscribers.delete(fn)
  }
  const target: Record<string, unknown> = Object.create(null)
  const admin: Record<string, unknown> = Object.create(null)
  const admissionOwners = new Set<string>()
  const close = (): Promise<void> =>
    (closing ??= (async () => {
      unsubscribe?.()
      await unpublish?.()
      listener?.disconnect()
      await cli?.close()
      await commandSocket?.close()
      try {
        await remote?.stop()
      } finally {
        if (live) await live.shutdown()
        else await server?.close()
        host.close()
        // The listening port is the storage ownership lock. Release it after SQLite has closed.
        await listener?.close()
      }
    })())
  try {
    listener = await listenAppServer({
      target,
      adminTarget: admin,
      host,
      origins: options.origins,
      port: appServerPort(home),
      subscribe: (fn) => subscribe(fn),
      onHostDisconnected: () => {
        if (closing) return
        // An updater's admission lease belongs to its attached shell.
        for (const owner of admissionOwners) server?.openRunAdmission(owner)
        admissionOwners.clear()
      }
    })
    const broker = new NativeProcessBroker(
      options.processHostPath ? { binaryPath: options.processHostPath } : {}
    )
    const jotdownStore = createJotdownStore(join(home, 'jotdowns'))
    const nativeFetch = createRpcWebExternalFetch(host)
    const activity = createRpcActivitySummarySource(host)
    try {
      server = (options.createServer ?? createSqliteYachiyoServer)({
        dbPath: join(home, 'yachiyo.sqlite'),
        settingsPath: join(home, 'config.toml'),
        seedPresetProviders: true,
        developmentMode: options.developmentMode,
        providerCredentialVault: options.vault,
        fetchImpl: options.fetchImpl ?? globalThis.fetch,
        // The native session supports OS proxies. With no shell, the server uses Node's fetch.
        webExternalFetchImpl: (input, init) =>
          host.connected
            ? nativeFetch(input, init)
            : (options.fetchImpl ?? globalThis.fetch)(input, init),
        activityTracker: {
          finalizeAndConsume: () => (host.connected ? activity.finalizeAndConsume() : null)
        },
        ...(options.nativeHost
          ? {
              browserAutomationService: createRpcBrowserAutomationBackend(host),
              browserSearchPageFactory: createRpcBrowserSearchPageFactory(host)
            }
          : { unavailableTools: ['useBrowser', 'webSearch', 'renderUi', 'createRemotePairingQr'] }),
        processBroker: broker,
        jotdownStore,
        jsReplWorkerPath: options.jsReplWorkerPath,
        pyReplRunnerPath: options.pyReplRunnerPath
      })
    } catch (error) {
      await broker.close()
      throw error
    }
    const runtime = server
    await runtime.initialize()
    const initialDemoMode = (await runtime.getConfig()).general?.demoMode === true
    runtime.getTtlReaper().start()
    const notify = (title: string, body?: string): void => {
      if (host.connected)
        void host
          .call('mainHost.showNotification', [{ title, body }])
          .catch((error) => options.log(`Notification failed: ${error}`))
      else options.log(`${title}: ${body ?? ''}`)
    }
    live = createRuntimeLiveServices({
      server: runtime,
      showNotification: ({ title, body }) => notify(title, body),
      updateReceiptLease: {
        claim: (channelId) =>
          host.connected
            ? (host.call('mainHost.claimUpdateReceipt', [{ channelId }]) as Promise<
                { claimToken: string; message: string } | undefined
              >)
            : Promise.resolve(undefined),
        ack: async (claimToken) => {
          await host.call('mainHost.ackUpdateReceipt', [{ claimToken }])
        },
        release: async (claimToken) => {
          if (host.connected) await host.call('mainHost.releaseUpdateReceipt', [{ claimToken }])
        }
      },
      tempWorkspaceDir: join(home, 'temp-workspace'),
      enableSchedules:
        options.liveServices !== false &&
        (!options.developmentMode || Boolean(process.env.YACHIYO_DEV_SCHEDULES)),
      enableChannels:
        options.liveServices !== false &&
        (!options.developmentMode || Boolean(process.env.YACHIYO_DEV_CHANNELS))
    })
    const services = live
    const hostCall = async (method: string, args: unknown[]): Promise<unknown> => {
      const operation = services.rpcOps[`host.${method}`]
      if (!operation) throw new Error(`Unknown runtime operation: ${method}`)
      return Reflect.apply(operation, services.rpcOps, args)
    }
    remote = options.secretBox
      ? createAppRemoteBinding({
          home,
          server: () => runtime,
          hostCall,
          secretBox: options.secretBox,
          version: options.version,
          subscribe,
          notify,
          keepAwake: {
            setWanted(wanted) {
              if (host.connected)
                void host
                  .call('mainHost.remoteKeepAwake', [wanted])
                  .catch((error) => options.log(`Keep awake failed: ${error}`))
            },
            dispose() {
              if (host.connected)
                void host
                  .call('mainHost.remoteKeepAwake', [false])
                  .catch((error) => options.log(`Keep awake failed: ${error}`))
            }
          }
        })
      : createUnavailableRemoteBinding()
    const remoteBinding = remote
    unsubscribe = runtime.subscribe((event) => {
      for (const fn of subscribers) fn(event)
      if (event.type === 'settings.updated') {
        void remoteBinding
          .apply(event.config.remote ?? DEFAULT_REMOTE_CONFIG)
          .catch((error) => options.log(`Remote configuration failed: ${error}`))
        if (
          options.developmentMode &&
          (event.config.general?.demoMode === true) !== initialDemoMode
        ) {
          // Finish the save response before replacing the development storage instance.
          setTimeout(() => {
            void close()
              .then(options.onShutdown)
              .catch((error) => options.log(`Demo mode restart failed: ${error}`))
          }, 0)
        }
      }
    })
    const journal = listener.journal
    Object.assign(
      target,
      createAppRpcTarget({
        server: runtime,
        live: services,
        host,
        jotdownStore,
        remote: remoteBinding,
        cursor: () => journal.cursor()
      })
    )
    const nativeMethods = [
      'getConfig',
      'cancelActiveRuns',
      'listActiveRunIds',
      'openThreadWorkspace',
      'markThreadReviewed'
    ] as const
    for (const method of nativeMethods)
      admin[method] = (...args: unknown[]) => Reflect.apply(runtime[method], runtime, args)
    Object.assign(
      admin,
      Object.fromEntries(
        Object.entries(services.rpcOps).filter(([name]) => name !== 'host.shutdownRuntime')
      ),
      {
        closeRunAdmissionAndGetActiveRunIds: (owner: string) => {
          if (typeof owner !== 'string' || !owner) throw new Error('Admission owner is required')
          admissionOwners.add(owner)
          return runtime.closeRunAdmissionAndGetActiveRunIds(owner)
        },
        openRunAdmission: (owner: string) => {
          runtime.openRunAdmission(owner)
          admissionOwners.delete(owner)
        },
        'server.status': () => ({
          version: options.version,
          buildId: options.buildId,
          pid: process.pid,
          home,
          nativeHost: host.connected
        }),
        'server.shutdown': () => {
          setTimeout(() => {
            void close()
              .then(options.onShutdown)
              .catch((error) => options.log(`Shutdown failed: ${error}`))
          }, 0)
          return true
        },
        remoteCommand: (request: RemoteCommandRequest) => remoteBinding.handleCommand(request)
      }
    )
    const cliTarget: Record<string, unknown> = Object.create(null)
    for (const name of [
      'getConfig',
      'saveConfig',
      'upsertProvider',
      'setDefaultProvider',
      'fetchProviderModels',
      'createThread',
      'sendChat',
      'cancelRun',
      'answerToolQuestion',
      'markThreadReviewed'
    ] as const) {
      cliTarget[name] = (...args: unknown[]) => Reflect.apply(runtime[name], runtime, args)
    }
    Object.assign(cliTarget, {
      pairRemote: () => remoteBinding.createPairingUrl(),
      remoteCommand: (request: RemoteCommandRequest) => remoteBinding.handleCommand(request),
      sendNotification: (input: { title: string; body?: string }) =>
        notify(input.title, input.body),
      sendChannelMessage: (input: unknown) => hostCall('sendChannelMessage', [input]),
      updateChannelGroup: (input: unknown) => hostCall('updateChannelGroupAndNotify', [input])
    })
    if (process.platform !== 'win32')
      cli = await listenLocalSocket({
        path: join(home, 'headless.sock'),
        target: cliTarget,
        subscribe
      })
    if (options.commandSocket !== false) {
      commandSocket = startCommandSocket({
        endpoint: resolveCommandEndpoint({ platform: process.platform, yachiyoHome: home }),
        onNotification: ({ title, body }) => notify(title, body),
        onSendChannel: (input) => {
          void hostCall('sendChannelMessage', [input]).catch((error) =>
            options.log(`Send failed: ${error}`)
          )
        },
        onUpdateChannelGroupStatus: (input) => {
          void hostCall('updateChannelGroupAndNotify', [input]).catch((error) =>
            options.log(`Group update failed: ${error}`)
          )
        },
        onUpdateChannelGroupLabel: (input) => {
          void hostCall('updateChannelGroupAndNotify', [input]).catch((error) =>
            options.log(`Group update failed: ${error}`)
          )
        },
        onMarkThreadReviewed: (input) => runtime.markThreadReviewed(input),
        onRemote: (request) => remoteBinding.handleCommand(request),
        onAppUpdate: async (input) => {
          const reply = (await host.call('mainHost.prepareAppUpdate', [input])) as {
            id: string
            result: AppUpdateCommandResult
          }
          return {
            result: reply.result,
            afterReply: async () => {
              await host.call('mainHost.finishAppUpdate', [reply.id, true])
            },
            onReplyFailure: async () => {
              await host.call('mainHost.finishAppUpdate', [reply.id, false])
            }
          }
        },
        onError: (error) => options.log(`Command socket failed: ${error}`)
      })
    }
    if (options.liveServices !== false) await services.start()
    await remoteBinding.apply((await runtime.getConfig()).remote ?? DEFAULT_REMOTE_CONFIG)
    unpublish = await publishAppServerAddress(home, listener.address)
    options.log(`App server ready at ${listener.address.url}`)
    return { server: runtime, host, address: listener.address, close }
  } catch (error) {
    await close()
    throw error
  }
  // The set is process-local; no stale admission lock survives a host disconnect.
}
