import { pathToFileURL } from 'node:url'

import {
  resolveYachiyoDbPath,
  resolveYachiyoSettingsPath,
  resolveYachiyoSoulPath
} from '@yachiyo/runtime/config/paths'
import { handleAgentCommand } from './commands/agent.ts'
import { handleChannelCommand } from './commands/channel.ts'
import { handleConfigCommand } from './commands/config.ts'
import { handleProviderCommand } from './commands/provider.ts'
import { handleScheduleCommand } from './commands/schedule.ts'
import { handleSendCommand } from './commands/send.ts'
import { handleSoulCommand } from './commands/soul.ts'
import { handleThreadCommand } from './commands/thread.ts'
import { parseArgs } from './core/args.ts'
import { NAMESPACE_HELP, USAGE, namespaceHelp } from './core/help.ts'
import type { RunYachiyoCliOptions } from './core/types.ts'
import { createDefaultConfigService } from './services/config.ts'

export async function runYachiyoCli(
  args = process.argv.slice(2),
  options: RunYachiyoCliOptions = {}
): Promise<void> {
  const stdout = options.stdout ?? process.stdout
  const { positionals, flags } = parseArgs(args)
  const namespace = positionals[0]

  if (flags.has('--help')) {
    if (namespace && namespace in NAMESPACE_HELP) {
      stdout.write(`${namespaceHelp(namespace)}\n`)
    } else {
      stdout.write(`${USAGE}\n`)
    }
    return
  }

  if (!namespace) {
    stdout.write(`${USAGE}\n`)
    return
  }

  const settingsPath = flags.get('--settings') ?? resolveYachiyoSettingsPath()
  const soulPath = flags.get('--soul') ?? resolveYachiyoSoulPath()
  const dbPath = flags.get('--db') ?? resolveYachiyoDbPath()

  if (namespace === 'soul') {
    await handleSoulCommand(positionals.slice(1), flags, soulPath, stdout, options)
    return
  }

  if (namespace === 'thread') {
    handleThreadCommand(positionals.slice(1), flags, dbPath, stdout, options)
    return
  }

  if (namespace === 'schedule') {
    await handleScheduleCommand(positionals.slice(1), flags, dbPath, stdout)
    return
  }

  if (namespace === 'channel') {
    await handleChannelCommand(positionals.slice(1), flags, dbPath, stdout, options)
    return
  }

  if (namespace === 'send') {
    await handleSendCommand(positionals.slice(1), flags, stdout, options)
    return
  }

  if (namespace !== 'provider' && namespace !== 'config' && namespace !== 'agent') {
    throw new Error(
      `Unknown namespace: ${namespace}. Expected: soul, provider, agent, config, thread, schedule, channel, send\n\n${USAGE}`
    )
  }

  const createConfigService = options.createConfigService ?? createDefaultConfigService
  const configService = createConfigService(settingsPath)

  if (namespace === 'provider') {
    await handleProviderCommand(positionals.slice(1), flags, configService, stdout)
    return
  }

  if (namespace === 'agent') {
    await handleAgentCommand(positionals.slice(1), flags, configService, stdout)
    return
  }

  await handleConfigCommand(positionals.slice(1), flags, configService, stdout)
}

async function main(): Promise<void> {
  await runYachiyoCli()
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`Error: ${message}\n`)
    process.exitCode = 1
  })
}
