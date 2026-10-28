import type { YachiyoServer } from '@yachiyo/runtime/app/host/YachiyoServer'
import type { SqliteYachiyoServerOptions } from '@yachiyo/runtime/app/host/options'
import { startAppServer } from '@yachiyo/runtime/appServer/host'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHeadlessProviderVault, createHeadlessSecretBox } from './credentials.ts'

export interface HeadlessHostOptions {
  home: string
  masterKey: Uint8Array
  version: string
  log: (line: string) => void
  /** Test hosts use in-memory storage while exercising the same sockets and lifecycle. */
  createServer?: (options: SqliteYachiyoServerOptions) => YachiyoServer
  liveServices?: boolean
  onShutdown?: () => void
  resourcesDir?: string
}

export interface HeadlessHost {
  server: YachiyoServer
  close(): Promise<void>
}

export async function startHeadlessHost(options: HeadlessHostOptions): Promise<HeadlessHost> {
  return startAppServer({
    home: options.home,
    version: options.version,
    vault: createHeadlessProviderVault(options.home, options.masterKey),
    secretBox: createHeadlessSecretBox(options.masterKey),
    log: options.log,
    createServer: options.createServer,
    liveServices: options.liveServices,
    onShutdown: options.onShutdown,
    ...(options.resourcesDir
      ? {
          processHostPath: join(options.resourcesDir, 'bin/process-host'),
          jsReplWorkerPath: pathToFileURL(join(options.resourcesDir, 'jsReplWorker.mjs')),
          pyReplRunnerPath: join(options.resourcesDir, 'pyReplRunner.py')
        }
      : {})
  })
}
