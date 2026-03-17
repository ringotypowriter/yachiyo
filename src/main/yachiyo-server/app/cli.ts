import { pathToFileURL } from 'node:url'

import type {
  ProviderConfig,
  ProviderSettings,
  SettingsConfig
} from '../../../shared/yachiyo/protocol'
import { resolveYachiyoDbPath, resolveYachiyoSettingsPath } from '../config/paths.ts'
import { createSqliteYachiyoServer, type YachiyoServer } from './YachiyoServer.ts'

const USAGE =
  'Usage: cli.ts <bootstrap|settings.get|settings.replace|settings.update|settings.provider.upsert|settings.provider.remove|settings.provider.model.enable|settings.provider.model.disable|thread.create|thread.rename|thread.archive> [--db <path>] [--settings <path>] [--json <payload>]'

interface CliStreams {
  stdout?: Pick<typeof process.stdout, 'write'>
  stderr?: Pick<typeof process.stderr, 'write'>
}

export interface RunCliOptions extends CliStreams {
  createServer?: (input: { dbPath: string; settingsPath: string }) => YachiyoServer
}

function readFlag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

function outputJson(stdout: Pick<typeof process.stdout, 'write'>, value: unknown): void {
  stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

function readJsonFlag<T>(args: string[], name: string): T {
  const raw = readFlag(args, name)
  return raw ? (JSON.parse(raw) as T) : ({} as T)
}

export async function runCli(
  args = process.argv.slice(2),
  options: RunCliOptions = {}
): Promise<void> {
  const stdout = options.stdout ?? process.stdout
  const command = args[0]
  const dbPath = readFlag(args, '--db') ?? resolveYachiyoDbPath()
  const settingsPath = readFlag(args, '--settings') ?? resolveYachiyoSettingsPath()

  if (!command) {
    throw new Error(USAGE)
  }

  const createServer = options.createServer ?? ((input) => createSqliteYachiyoServer(input))
  const server = createServer({ dbPath, settingsPath })

  try {
    if (command === 'bootstrap') {
      outputJson(stdout, await server.bootstrap())
      return
    }

    if (command === 'settings.get') {
      outputJson(stdout, await server.getConfig())
      return
    }

    if (command === 'settings.update') {
      const payload = readJsonFlag<Partial<ProviderSettings>>(args, '--json')
      outputJson(stdout, await server.saveSettings(payload))
      return
    }

    if (command === 'settings.replace') {
      outputJson(stdout, await server.saveConfig(readJsonFlag<SettingsConfig>(args, '--json')))
      return
    }

    if (command === 'settings.provider.upsert') {
      outputJson(stdout, await server.upsertProvider(readJsonFlag<ProviderConfig>(args, '--json')))
      return
    }

    if (command === 'settings.provider.remove') {
      outputJson(
        stdout,
        await server.removeProvider(readJsonFlag<{ name: string }>(args, '--json'))
      )
      return
    }

    if (command === 'settings.provider.model.enable') {
      outputJson(
        stdout,
        await server.enableProviderModel(
          readJsonFlag<{ name: string; model: string }>(args, '--json')
        )
      )
      return
    }

    if (command === 'settings.provider.model.disable') {
      outputJson(
        stdout,
        await server.disableProviderModel(
          readJsonFlag<{ name: string; model: string }>(args, '--json')
        )
      )
      return
    }

    if (command === 'thread.create') {
      outputJson(stdout, await server.createThread())
      return
    }

    if (command === 'thread.rename') {
      outputJson(
        stdout,
        await server.renameThread(readJsonFlag<{ threadId: string; title: string }>(args, '--json'))
      )
      return
    }

    if (command === 'thread.archive') {
      await server.archiveThread(readJsonFlag<{ threadId: string }>(args, '--json'))
      outputJson(stdout, { ok: true })
      return
    }

    throw new Error(`Unknown command: ${command}`)
  } finally {
    await server.close()
  }
}

async function main(): Promise<void> {
  await runCli()
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`${message}\n`)
    process.exitCode = 1
  })
}
