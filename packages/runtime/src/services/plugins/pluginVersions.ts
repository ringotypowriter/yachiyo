import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { resolveYachiyoPluginsDir } from '../../config/paths.ts'
import { assertPluginFileName, readPluginSources } from './pluginFiles.ts'
import {
  PluginDataStore,
  PluginStateConflictError,
  writeImmutablePluginFile
} from './pluginDataStore.ts'
import type { PluginSource } from './pluginTypes.ts'

const revisionSchema = z.string().regex(/^[a-f0-9]{64}$/)
const releaseSchema = z
  .object({
    active: revisionSchema,
    previous: revisionSchema.optional()
  })
  .strict()
const sourceSchema = z
  .object({
    name: z.string(),
    source: z.string(),
    revision: revisionSchema
  })
  .strict()

export interface PluginVersionStatus {
  active?: string
  previous?: string
  revisions: string[]
}

/** Draft files are separate from immutable sources selected for future runs. */
export class PluginVersions {
  readonly directory: string
  private readonly store: PluginDataStore

  constructor(directory = resolveYachiyoPluginsDir()) {
    this.directory = directory
    this.store = new PluginDataStore(join(directory, '.releases'))
  }

  private revisionPath(name: string, revision: string): string {
    assertPluginFileName(name)
    revisionSchema.parse(revision)
    return join(this.directory, '.versions', name, `${revision}.json`)
  }

  async status(name: string): Promise<PluginVersionStatus> {
    assertPluginFileName(name)
    const record = await this.store.read([name])
    const release = record.version === 0 ? undefined : releaseSchema.parse(record.value)
    const files = await readdir(join(this.directory, '.versions', name)).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return []
        throw error
      }
    )
    return {
      ...release,
      revisions: files
        .filter((file) => /^[a-f0-9]{64}\.json$/.test(file))
        .map((file) => file.slice(0, -5))
        .sort()
    }
  }

  async activate(source: PluginSource): Promise<void> {
    sourceSchema.parse(source)
    const path = this.revisionPath(source.name, source.revision)
    const current = await this.store.read([source.name])
    const release = current.version === 0 ? undefined : releaseSchema.parse(current.value)
    await writeImmutablePluginFile(path, JSON.stringify(source)).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error
      }
    )
    if (release?.active === source.revision) return
    await this.store.write([source.name], current.version, {
      active: source.revision,
      ...(release ? { previous: release.active } : {})
    })
  }

  async rollback(name: string, revision?: string): Promise<PluginSource> {
    assertPluginFileName(name)
    const record = await this.store.read([name])
    if (record.version === 0) throw new Error(`Plugin ${name} has no activated version`)
    const release = releaseSchema.parse(record.value)
    const target = revision ?? release.previous
    if (!target) throw new Error(`Plugin ${name} has no previous version`)
    const source = await this.readRevision(name, target)
    await this.store.write([name], record.version, { active: target, previous: release.active })
    return source
  }

  private async readRevision(name: string, revision: string): Promise<PluginSource> {
    const source = sourceSchema.parse(
      JSON.parse(await readFile(this.revisionPath(name, revision), 'utf8'))
    )
    if (source.name !== name || source.revision !== revision) {
      throw new Error(`Plugin source identity mismatch: ${name}@${revision}`)
    }
    return source
  }

  async readEnabled(names: readonly string[]): Promise<PluginSource[]> {
    return Promise.all(
      names.map(async (name) => {
        assertPluginFileName(name)
        let record = await this.store.read([name])
        if (record.version === 0) {
          // Pin plugins enabled by v1/config.toml on their first run after the upgrade.
          const [source] = await readPluginSources([name], this.directory)
          try {
            await this.activate(source)
          } catch (error) {
            if (!(error instanceof PluginStateConflictError)) throw error
          }
          record = await this.store.read([name])
        }
        return this.readRevision(name, releaseSchema.parse(record.value).active)
      })
    )
  }
}
