import { startAppServer, type RunningAppServer } from '@yachiyo/runtime/appServer/host'
import { createAppServerSecretBox } from '@yachiyo/runtime/appServer/secretBox'
import { resolveYachiyoDataDir } from '@yachiyo/runtime/config/paths'
import jsReplWorkerPath from '@yachiyo/runtime/tools/agentTools/jsReplWorker?modulePath'
import pyReplRunnerPath from '@yachiyo/runtime/tools/agentTools/pyReplRunner.py?asset'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createProviderFetch } from '../net/providerFetch.ts'
import { createRuntimeProviderCredentialVault } from '../security/runtimeProviderCredentials.ts'

// Packaged helper/resource resolution also works when Electron runs as plain Node.
if (process.env.YACHIYO_RESOURCES_PATH) {
  Object.defineProperty(process, 'resourcesPath', {
    value: process.env.YACHIYO_RESOURCES_PATH,
    configurable: true
  })
  Object.defineProperty(process, 'defaultApp', {
    value: process.env.YACHIYO_DEFAULT_APP === '1',
    configurable: true
  })
}

let running: RunningAppServer | undefined
let stopping = false
async function stop(): Promise<void> {
  if (stopping) return
  stopping = true
  await running?.close()
  process.exit(0)
}

async function main(): Promise<void> {
  process.umask(0o077)
  let input = ''
  for await (const chunk of process.stdin) {
    input += chunk.toString()
    if (Buffer.byteLength(input) > 16 * 1024 * 1024)
      throw new Error('Startup credentials exceed the size limit')
  }
  const message = JSON.parse(input) as {
    providerCredentialMode: string
    providerCredentialKey?: string
    legacyRemoteSecrets?: Record<string, string>
  }
  const key = message.providerCredentialKey
    ? Buffer.from(message.providerCredentialKey, 'base64')
    : undefined
  const vault = createRuntimeProviderCredentialVault({ ...message, providerCredentialKey: key })
  const developmentMode = process.env.YACHIYO_RUNTIME_DEV === '1'
  running = await startAppServer({
    home: resolveYachiyoDataDir(),
    version: process.env.YACHIYO_APP_VERSION!,
    buildId: createHash('sha256').update(readFileSync(__filename)).digest('hex'),
    vault,
    secretBox: key ? createAppServerSecretBox(key, message.legacyRemoteSecrets) : undefined,
    nativeHost: true,
    developmentMode,
    jsReplWorkerPath,
    pyReplRunnerPath,
    commandSocket: !developmentMode || Boolean(process.env.YACHIYO_DEV_CLI),
    fetchImpl: createProviderFetch({ env: process.env, netFetch: globalThis.fetch }),
    origins:
      developmentMode && process.env.ELECTRON_RENDERER_URL
        ? [new URL(process.env.ELECTRON_RENDERER_URL).origin]
        : [],
    log: console.log,
    onShutdown: () => process.exit(0)
  })
  process.on('SIGTERM', () => {
    void stop().catch(fatal)
  })
  process.on('SIGINT', () => {
    void stop().catch(fatal)
  })
}

function fatal(error: unknown): void {
  console.error('[app-server]', error)
  process.exit(1)
}

process.on('uncaughtException', fatal)
process.on('unhandledRejection', fatal)
void main().catch(fatal)
