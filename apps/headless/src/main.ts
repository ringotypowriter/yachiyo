import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { format } from 'node:util'

import { parseArgs } from '@yachiyo/cli/core/args'
import type { CliConfigService } from '@yachiyo/cli/core/types'
import { createDefaultConfigService } from '@yachiyo/cli/services/config'
import { connectHeadless, resolveHeadlessSocketPath } from '@yachiyo/cli/services/headless'
import { runYachiyoCli } from '@yachiyo/cli/yachiyoCli'
import { isSocketRunning } from '@yachiyo/runtime/appServer/cliSocket'
import { resolveYachiyoDataDir } from '@yachiyo/runtime/config/paths'
import { createRpcMethodProxy } from '@yachiyo/shared/rpc/rpcClient'
import { createHeadlessProviderVault, readMasterKey, resolveMasterKeyPath } from './credentials.ts'
import { startHeadlessHost } from './host.ts'
import { initializeHeadless } from './initialize.ts'

const HELP = `Yachiyo headless

  yachiyo init                         Create settings and a local encryption key
  yachiyo serve                        Run the app server (foreground process)
  yachiyo server status                Inspect the running app server
  yachiyo server stop                  Stop the app server
  yachiyo chat [prompt]                 Start a conversation; accepts piped text
  yachiyo chat --thread <id>            Continue a conversation
  yachiyo remote pair                  Print a five-minute pairing URL as JSON
  yachiyo remote activate <code>       Activate a relay invitation
  yachiyo remote status                Show the running Remote service
  yachiyo remote pairings list         List paired phones
  yachiyo remote pairings revoke <id>  Unpair a phone

Provider, config, agent, thread, soul, schedule, channel, send, and doctor commands
are also available. Use <command> --help for details.

YACHIYO_HOME selects the data directory (default ~/.yachiyo).
YACHIYO_MASTER_KEY_FILE selects a raw 32-byte key file (mode 0600 or 0400).
Remote settings take effect in the running service.
`

async function main(): Promise<void> {
  process.umask(0o077)
  const args = process.argv.slice(2)
  const { positionals, flags } = parseArgs(args)
  const command = positionals[0]
  if (!command || (flags.has('--help') && ['init', 'serve', 'remote'].includes(command))) {
    process.stdout.write(HELP)
    return
  }
  if (flags.has('--help')) return runYachiyoCli(args)
  if (process.platform === 'win32') throw new Error('Headless requires Linux or macOS Unix sockets')
  const home = resolve(resolveYachiyoDataDir())
  process.env.YACHIYO_HOME = home
  const bundled = import.meta.url.endsWith('/main.mjs')
  const resourcesDir = bundled ? fileURLToPath(new URL('.', import.meta.url)) : undefined
  if (resourcesDir) process.env.YACHIYO_RESOURCES_PATH = resourcesDir
  if (flags.has('--settings') || flags.has('--db')) {
    throw new Error('Use YACHIYO_HOME to select the headless settings and database together')
  }
  if (command === 'init') {
    if (await isSocketRunning(resolveHeadlessSocketPath(home)))
      throw new Error('Stop yachiyo serve before running init')
    process.stdout.write(JSON.stringify(initializeHeadless(home), null, 2) + '\n')
    return
  }
  if (command === 'serve') {
    // Runtime logs belong on stderr, leaving command stdout suitable for pipes.
    console.log = (...values: unknown[]): void => {
      process.stderr.write(format(...values) + '\n')
    }
    const manifestPath = new URL(bundled ? './package.json' : '../package.json', import.meta.url)
    const { version } = JSON.parse(readFileSync(manifestPath, 'utf8')) as { version: string }
    const host = await startHeadlessHost({
      home,
      masterKey: readMasterKey(resolveMasterKeyPath(home)),
      version,
      resourcesDir,
      onShutdown: () => process.exit(0),
      log: (line) => process.stderr.write(`[headless] ${line}\n`)
    })
    process.stderr.write(`Yachiyo headless ready at ${home}\n`)
    await new Promise<void>((resolve) => {
      const stop = (): void => {
        process.off('SIGINT', stop)
        process.off('SIGTERM', stop)
        resolve()
      }
      process.once('SIGINT', stop)
      process.once('SIGTERM', stop)
    })
    await host.close()
    return
  }
  if (command === 'update')
    throw new Error('Update the headless installation and restart its service')
  const configCommand = ['config', 'provider', 'agent'].includes(command)
  const socketCommand = ['remote', 'send', 'channel'].includes(command)
  if (configCommand && !(await isSocketRunning(resolveHeadlessSocketPath(home)))) {
    const vault = createHeadlessProviderVault(home, readMasterKey(resolveMasterKeyPath(home)))
    return runYachiyoCli(args, {
      createConfigService: (settingsPath) =>
        createDefaultConfigService(settingsPath, { providerCredentialVault: vault })
    })
  }
  if (!configCommand && !socketCommand) return runYachiyoCli(args)
  const { client } = await connectHeadless()
  try {
    await runYachiyoCli(args, {
      createConfigService: () => createRpcMethodProxy<CliConfigService>(client),
      createRemotePairing: () =>
        client.call('pairRemote', []) as Promise<{ url: string; expiresAt: string }>,
      requestRemote: (_path, request) => client.call('remoteCommand', [request]),
      sendNotification: async (_path, input) => {
        await client.call('sendNotification', [input])
      },
      sendChannel: async (_path, input) => {
        await client.call('sendChannelMessage', [input])
      },
      sendChannelGroupStatus: async (_path, input) => {
        await client.call('updateChannelGroup', [{ id: input.id, status: input.status }])
      },
      sendChannelGroupLabel: async (_path, input) => {
        await client.call('updateChannelGroup', [{ id: input.id, label: input.label }])
      },
      sendMarkThreadReviewed: async (_path, input) => {
        await client.call('markThreadReviewed', [input])
      }
    })
  } finally {
    client.close()
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
