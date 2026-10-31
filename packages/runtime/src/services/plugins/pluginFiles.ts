import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import { join } from 'node:path'
import { resolveYachiyoPluginsDir } from '../../config/paths.ts'
import type { PluginSource } from './pluginTypes.ts'

export function assertPluginFileName(name: string): void {
  if (!/^[a-z][a-z0-9-]*\.(?:js|mjs|ts)$/.test(name)) {
    throw new Error(`Invalid plugin filename: ${name}. Use a name such as project-context.ts.`)
  }
}

export async function listPluginFiles(directory = resolveYachiyoPluginsDir()): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return []
    throw error
  })
  return entries
    .filter((entry) => entry.isFile() && /^[a-z][a-z0-9-]*\.(?:js|mjs|ts)$/.test(entry.name))
    .map((entry) => entry.name)
    .sort()
}

export async function readPluginSources(
  names: readonly string[],
  directory = resolveYachiyoPluginsDir()
): Promise<PluginSource[]> {
  return Promise.all(
    names.map(async (name): Promise<PluginSource> => {
      assertPluginFileName(name)
      const raw = await readFile(join(directory, name), 'utf8')
      const source = name.endsWith('.ts')
        ? stripTypeScriptTypes(raw, { mode: 'transform', sourceUrl: name })
        : raw
      return {
        name,
        source,
        revision: createHash('sha256').update(raw).digest('hex')
      }
    })
  )
}
