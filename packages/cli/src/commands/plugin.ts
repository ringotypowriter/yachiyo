import { dirname, join } from 'node:path'
import {
  assertPluginFileName,
  listPluginFiles,
  readPluginSources
} from '@yachiyo/runtime/services/plugins/pluginFiles'
import { PluginSession } from '@yachiyo/runtime/services/plugins/pluginSession'
import type { CliConfigService, CliStdout } from '../core/types.ts'
import { namespaceHelp } from '../core/help.ts'

export async function handlePluginCommand(
  positionals: string[],
  settingsPath: string,
  configService: CliConfigService,
  stdout: CliStdout
): Promise<void> {
  const [action, name] = positionals
  if (!action) {
    stdout.write(`${namespaceHelp('plugin')}\n`)
    return
  }
  const directory = join(dirname(settingsPath), 'plugins')
  const config = await configService.getConfig()
  const enabled = config.plugins?.enabled ?? []
  if (action === 'list') {
    const files = await listPluginFiles(directory)
    stdout.write(
      `${JSON.stringify(
        {
          directory,
          plugins: [...new Set([...files, ...enabled])].map((file) => ({
            name: file,
            enabled: enabled.includes(file),
            missing: !files.includes(file)
          }))
        },
        null,
        2
      )}\n`
    )
    return
  }
  if (action !== 'check' && action !== 'enable' && action !== 'disable') {
    throw new Error(`Unknown plugin action: ${action}. Expected: list, check, enable, disable.`)
  }
  if (!name || positionals.length !== 2) {
    throw new Error(`Usage: yachiyo plugin ${action} <filename>`)
  }
  assertPluginFileName(name)
  if (action === 'disable') {
    await configService.saveConfig({
      ...config,
      plugins: { enabled: enabled.filter((file) => file !== name) }
    })
    stdout.write(`${JSON.stringify({ name, enabled: false, effective: 'next-run' })}\n`)
    return
  }

  const sources = await readPluginSources([name], directory)
  const session = await PluginSession.create(sources)
  try {
    const [descriptor] = session.descriptors
    if (action === 'check') {
      stdout.write(`${JSON.stringify(descriptor, null, 2)}\n`)
      return
    }
    await configService.saveConfig({
      ...config,
      plugins: { enabled: [...new Set([...enabled, name])] }
    })
    stdout.write(
      `${JSON.stringify({ ...descriptor, enabled: true, effective: 'next-run' }, null, 2)}\n`
    )
  } finally {
    await session.dispose()
  }
}
