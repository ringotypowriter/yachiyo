/**
 * Runtime host entry, forked as an Electron utilityProcess (the default
 * runtime mode; YACHIYO_RUNTIME_UTILITY=0 keeps the runtime in the main
 * process instead). Boots the full YachiyoServer off the main
 * process's event loop and serves it over RPC on the MessagePort delivered
 * via parentPort. Main-process-only capabilities (browser automation pages,
 * browser search pages, activity summaries) are consumed through reverse RPC
 * on the same port.
 *
 * See docs/yachiyo-runtime-process-extraction.md.
 */
import { net } from 'electron'

import { createRpcActivitySummarySource } from '@yachiyo/runtime/activity/activityTrackerRpcBridge'
import { createRuntimeLiveServices } from '@yachiyo/runtime/app/host/runtimeLiveServices'
import {
  createSqliteYachiyoServer,
  type YachiyoServer
} from '@yachiyo/runtime/app/host/YachiyoServer'
import {
  resolveYachiyoDbPath,
  resolveYachiyoJotdownsDir,
  resolveYachiyoSettingsPath,
  resolveYachiyoTempWorkspaceRoot
} from '@yachiyo/runtime/config/paths'
import { createRpcBrowserAutomationBackend } from '@yachiyo/runtime/services/browserAutomation/browserAutomationRpcBridge'
import { createJotdownStore } from '@yachiyo/runtime/services/jotdownStore'
import { createRpcWebExternalFetch } from '@yachiyo/runtime/services/webExternalFetchRpcBridge'
import { createRpcBrowserSearchPageFactory } from '@yachiyo/runtime/services/webSearch/browserSearchPageFactoryRpcBridge'
import {
  messagePortMainTransport,
  type MessagePortMainLike
} from '@yachiyo/shared/rpc/messagePortMainTransport'
import { mergeRpcTargets } from '@yachiyo/shared/rpc/mergeRpcTargets'
import { createRpcClient } from '@yachiyo/shared/rpc/rpcClient'
import { serveRpcTarget } from '@yachiyo/shared/rpc/rpcServer'

import { createProviderFetch } from '../net/providerFetch.ts'

// Route global fetch through Electron's net module, mirroring the main
// process (spike-verified available inside utility processes).
const netFetch: typeof globalThis.fetch = (input, init?) =>
  net.fetch(input instanceof URL ? input.toString() : (input as string | Request), init)
globalThis.fetch = netFetch

let server: YachiyoServer | null = null

process.parentPort.on('message', (event) => {
  const [port] = event.ports
  if (!port) {
    console.error('[runtime-host] control message carried no MessagePort')
    return
  }
  if (server) {
    console.error('[runtime-host] runtime already started; ignoring extra port')
    return
  }

  const transport = messagePortMainTransport(port as MessagePortMainLike)
  const mainServices = createRpcClient(transport)
  const developmentMode = process.env['YACHIYO_RUNTIME_DEV'] === '1'

  server = createSqliteYachiyoServer({
    dbPath: resolveYachiyoDbPath(),
    settingsPath: resolveYachiyoSettingsPath(),
    developmentMode,
    seedPresetProviders: true,
    fetchImpl: createProviderFetch({ env: process.env, netFetch }),
    // The cert-relaxed web-external session only exists in the main process;
    // forward those requests there, streaming responses back over RPC.
    webExternalFetchImpl: createRpcWebExternalFetch(mainServices),
    jotdownStore: createJotdownStore(resolveYachiyoJotdownsDir()),
    browserAutomationService: createRpcBrowserAutomationBackend(mainServices),
    browserSearchPageFactory: createRpcBrowserSearchPageFactory(mainServices),
    activityTracker: createRpcActivitySummarySource(mainServices)
  })
  server.getTtlReaper().start()

  const liveServices = createRuntimeLiveServices({
    server,
    showNotification: (input) => {
      void mainServices
        .call('mainHost.showNotification', [input])
        .catch((error) => console.error('[runtime-host] notification failed:', error))
    },
    tempWorkspaceDir: resolveYachiyoTempWorkspaceRoot(),
    enableSchedules: !developmentMode || Boolean(process.env['YACHIYO_DEV_SCHEDULES']),
    enableChannels: !developmentMode || Boolean(process.env['YACHIYO_DEV_CHANNELS'])
  })

  serveRpcTarget({
    transport,
    target: mergeRpcTargets(liveServices.rpcOps, server),
    subscribe: (listener) => server!.subscribe(listener)
  })
  void liveServices
    .start()
    .then(() => console.log('[runtime-host] live services started'))
    .catch((error) => console.error('[runtime-host] live services failed to start:', error))
  console.log('[runtime-host] YachiyoServer serving over MessagePort')
})

process.on('uncaughtExceptionMonitor', (error) => {
  const message = error instanceof Error ? error.message : String(error)
  try {
    server?.recoverInterruptedRuns(`Fatal runtime-host error interrupted the run: ${message}`)
  } catch (recoveryError) {
    console.error('[runtime-host] failed to persist interrupted runs', recoveryError)
  }
})

process.on('uncaughtException', (error) => {
  console.error('[runtime-host] uncaughtException:', error)
})

process.on('unhandledRejection', (reason) => {
  console.error('[runtime-host] unhandledRejection:', reason)
})
