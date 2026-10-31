import { randomUUID } from 'node:crypto'
import { readFile, readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveYachiyoPluginsDir } from '../../config/paths.ts'
import { assertPluginFileName } from './pluginFiles.ts'
import { writeImmutablePluginFile } from './pluginDataStore.ts'
import type { PluginHookDiagnostic, PluginRunSnapshot } from './pluginTypes.ts'

export interface PluginRunDiagnostic {
  runId: string
  revision: string
  status: string
  finishedAt: string
  hooks: PluginHookDiagnostic[]
  error?: string
}

async function reportFiles(directory: string): Promise<string[]> {
  const files = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  return files
    .filter((file) => /^\d{13}-[a-f0-9-]+\.json$/.test(file))
    .sort()
    .reverse()
}

export async function recordPluginDiagnostics(
  snapshot: PluginRunSnapshot,
  status: string
): Promise<void> {
  if (!snapshot.context) return
  const hooks = [...(snapshot.diagnostics ?? []), ...(snapshot.session?.getDiagnostics() ?? [])]
  for (const source of snapshot.sources ?? []) {
    assertPluginFileName(source.name)
    const directory = join(
      snapshot.directory ?? resolveYachiyoPluginsDir(),
      '.diagnostics',
      source.name
    )
    const report: PluginRunDiagnostic = {
      runId: snapshot.context.runId,
      revision: source.revision,
      status,
      finishedAt: new Date().toISOString(),
      hooks: hooks.filter((hook) => hook.name === source.name),
      ...(snapshot.error ? { error: snapshot.error } : {})
    }
    await writeImmutablePluginFile(
      join(directory, `${Date.now()}-${randomUUID()}.json`),
      JSON.stringify(report)
    )
    for (const file of (await reportFiles(directory)).slice(20)) {
      await unlink(join(directory, file)).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
      })
    }
  }
}

export async function readPluginDiagnostics(
  name: string,
  root = resolveYachiyoPluginsDir()
): Promise<unknown[]> {
  assertPluginFileName(name)
  const directory = join(root, '.diagnostics', name)
  return Promise.all(
    (await reportFiles(directory))
      .slice(0, 5)
      .map(async (file) => JSON.parse(await readFile(join(directory, file), 'utf8')) as unknown)
  )
}
