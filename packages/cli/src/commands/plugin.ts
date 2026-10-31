import { dirname, join } from 'node:path'
import { readFile } from 'node:fs/promises'
import {
  assertPluginFileName,
  listPluginFiles,
  readPluginSources
} from '@yachiyo/runtime/services/plugins/pluginFiles'
import { PluginSession } from '@yachiyo/runtime/services/plugins/pluginSession'
import { PluginVersions } from '@yachiyo/runtime/services/plugins/pluginVersions'
import { trialPlugins } from '@yachiyo/runtime/services/plugins/pluginTrial'
import { readPluginDiagnostics } from '@yachiyo/runtime/services/plugins/pluginDiagnostics'
import type { CliConfigService, CliStdout } from '../core/types.ts'
import { namespaceHelp } from '../core/help.ts'

export async function handlePluginCommand(
  positionals: string[],
  settingsPath: string,
  configService: CliConfigService,
  stdout: CliStdout
): Promise<void> {
  const [action, name, argument] = positionals
  if (!action) {
    stdout.write(`${namespaceHelp('plugin')}\n`)
    return
  }
  const directory = join(dirname(settingsPath), 'plugins')
  const config = await configService.getConfig()
  const enabled = config.plugins?.enabled ?? []
  const versions = new PluginVersions(directory)
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
  if (
    !['check', 'enable', 'activate', 'disable', 'status', 'history', 'rollback', 'trial'].includes(
      action
    )
  ) {
    throw new Error(
      `Unknown plugin action: ${action}. Expected: list, check, trial, enable, activate, disable, status, history, rollback.`
    )
  }
  const acceptsArgument = action === 'trial' || action === 'rollback'
  if (
    !name ||
    positionals.length > (acceptsArgument ? 3 : 2) ||
    (action === 'trial' && !argument)
  ) {
    if (action === 'trial') throw new Error('Usage: yachiyo plugin trial <filename> <fixture.json>')
    throw new Error(`Usage: yachiyo plugin ${action} <filename>`)
  }
  assertPluginFileName(name)
  if (action === 'history' || action === 'status') {
    stdout.write(
      `${JSON.stringify({ name, enabled: enabled.includes(name), ...(await versions.status(name)), ...(action === 'status' ? { runs: await readPluginDiagnostics(name, directory) } : {}) }, null, 2)}\n`
    )
    return
  }
  if (action === 'rollback') {
    const source = await versions.rollback(name, argument)
    stdout.write(
      `${JSON.stringify({ name, revision: source.revision, enabled: enabled.includes(name), effective: 'next-run' }, null, 2)}\n`
    )
    return
  }
  if (action === 'disable') {
    await configService.saveConfig({
      ...config,
      plugins: { enabled: enabled.filter((file) => file !== name) }
    })
    stdout.write(`${JSON.stringify({ name, enabled: false, effective: 'next-run' })}\n`)
    return
  }

  const sources = await readPluginSources([name], directory)
  if (action === 'trial') {
    const fixture: unknown = JSON.parse(await readFile(argument!, 'utf8'))
    stdout.write(`${JSON.stringify(await trialPlugins(sources, fixture, config), null, 2)}\n`)
    return
  }
  const session = await PluginSession.create(sources)
  try {
    const [descriptor] = session.descriptors
    if (action === 'check') {
      stdout.write(`${JSON.stringify(descriptor, null, 2)}\n`)
      return
    }
    await versions.activate(sources[0])
    if (!enabled.includes(name))
      await configService.saveConfig({
        ...config,
        plugins: { enabled: [...enabled, name] }
      })
    stdout.write(
      `${JSON.stringify({ ...descriptor, enabled: true, effective: 'next-run' }, null, 2)}\n`
    )
  } finally {
    await session.dispose()
  }
}
