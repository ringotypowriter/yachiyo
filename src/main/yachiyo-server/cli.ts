import { argv } from 'node:process'

import type { ProviderConfig, ProviderSettings, SettingsConfig } from '../../shared/yachiyo/protocol'
import { resolveYachiyoDbPath, resolveYachiyoSettingsPath } from './paths.ts'
import { YachiyoServer } from './YachiyoServer.ts'

const USAGE =
  'Usage: cli.ts <bootstrap|settings.get|settings.replace|settings.update|settings.provider.upsert|settings.provider.remove|settings.provider.model.enable|settings.provider.model.disable|thread.create|thread.rename|thread.archive> [--db <path>] [--settings <path>] [--json <payload>]'

function readFlag(name: string): string | undefined {
  const index = argv.indexOf(name)
  return index >= 0 ? argv[index + 1] : undefined
}

function outputJson(value: unknown) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

function readJsonFlag<T>(name: string): T {
  const raw = readFlag(name)
  return raw ? (JSON.parse(raw) as T) : ({} as T)
}

async function main() {
  const command = argv[2]
  const dbPath = readFlag('--db') ?? resolveYachiyoDbPath()
  const settingsPath = readFlag('--settings') ?? resolveYachiyoSettingsPath()

  if (!command) {
    throw new Error(USAGE)
  }

  const server = new YachiyoServer({ dbPath, settingsPath })

  try {
    if (command === 'bootstrap') {
      outputJson(await server.bootstrap())
      return
    }

    if (command === 'settings.get') {
      outputJson(await server.getConfig())
      return
    }

    if (command === 'settings.update') {
      const payload = readJsonFlag<Partial<ProviderSettings>>('--json')
      outputJson(await server.saveSettings(payload))
      return
    }

    if (command === 'settings.replace') {
      outputJson(await server.saveConfig(readJsonFlag<SettingsConfig>('--json')))
      return
    }

    if (command === 'settings.provider.upsert') {
      outputJson(await server.upsertProvider(readJsonFlag<ProviderConfig>('--json')))
      return
    }

    if (command === 'settings.provider.remove') {
      outputJson(await server.removeProvider(readJsonFlag<{ name: string }>('--json')))
      return
    }

    if (command === 'settings.provider.model.enable') {
      outputJson(
        await server.enableProviderModel(readJsonFlag<{ name: string; model: string }>('--json')),
      )
      return
    }

    if (command === 'settings.provider.model.disable') {
      outputJson(
        await server.disableProviderModel(readJsonFlag<{ name: string; model: string }>('--json')),
      )
      return
    }

    if (command === 'thread.create') {
      outputJson(await server.createThread())
      return
    }

    if (command === 'thread.rename') {
      outputJson(
        await server.renameThread(readJsonFlag<{ threadId: string; title: string }>('--json')),
      )
      return
    }

    if (command === 'thread.archive') {
      await server.archiveThread(readJsonFlag<{ threadId: string }>('--json'))
      outputJson({ ok: true })
      return
    }

    throw new Error(`Unknown command: ${command}`)
  } finally {
    await server.close()
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`${message}\n`)
  process.exitCode = 1
})
