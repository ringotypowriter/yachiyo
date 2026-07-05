/**
 * Runtime host entry, forked as an Electron utilityProcess when
 * YACHIYO_RUNTIME_UTILITY=1. Boots the full YachiyoServer off the main
 * process's event loop and serves it over RPC on the MessagePort delivered
 * via parentPort. Main-process-only capabilities (browser automation pages,
 * browser search pages, activity summaries) are consumed through reverse RPC
 * on the same port.
 *
 * Not yet wired in this mode: schedule/channel/auto-sync live services and
 * the cert-relaxed web-external fetch session (webRead and image downloads
 * fall back to net.fetch). See docs/yachiyo-runtime-process-extraction.md.
 */
import { net } from 'electron'

import { createRpcActivitySummarySource } from '@yachiyo/runtime/activity/activityTrackerRpcBridge'
import {
  createSqliteYachiyoServer,
  type YachiyoServer
} from '@yachiyo/runtime/app/host/YachiyoServer'
import {
  resolveYachiyoDbPath,
  resolveYachiyoJotdownsDir,
  resolveYachiyoSettingsPath
} from '@yachiyo/runtime/config/paths'
import { createRpcBrowserAutomationBackend } from '@yachiyo/runtime/services/browserAutomation/browserAutomationRpcBridge'
import { createJotdownStore } from '@yachiyo/runtime/services/jotdownStore'
import { createRpcBrowserSearchPageFactory } from '@yachiyo/runtime/services/webSearch/browserSearchPageFactoryRpcBridge'
import {
  messagePortMainTransport,
  type MessagePortMainLike
} from '@yachiyo/shared/rpc/messagePortMainTransport'
import { createRpcClient } from '@yachiyo/shared/rpc/rpcClient'
import { serveRpcTarget } from '@yachiyo/shared/rpc/rpcServer'

// Route global fetch through Electron's net module, mirroring the main
// process (spike-verified available inside utility processes).
globalThis.fetch = (input, init?) =>
  net.fetch(input instanceof URL ? input.toString() : (input as string | Request), init)

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

  server = createSqliteYachiyoServer({
    dbPath: resolveYachiyoDbPath(),
    settingsPath: resolveYachiyoSettingsPath(),
    developmentMode: process.env['YACHIYO_RUNTIME_DEV'] === '1',
    seedPresetProviders: true,
    fetchImpl: (input, init) =>
      net.fetch(input instanceof URL ? input.toString() : (input as string | Request), init),
    // webExternalFetchImpl intentionally omitted: the cert-relaxed session
    // only exists in the main process; consumers fall back to fetchImpl.
    jotdownStore: createJotdownStore(resolveYachiyoJotdownsDir()),
    browserAutomationService: createRpcBrowserAutomationBackend(mainServices),
    browserSearchPageFactory: createRpcBrowserSearchPageFactory(mainServices),
    activityTracker: createRpcActivitySummarySource(mainServices)
  })
  server.getTtlReaper().start()
  serveRpcTarget({
    transport,
    target: server,
    subscribe: (listener) => server!.subscribe(listener)
  })
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
