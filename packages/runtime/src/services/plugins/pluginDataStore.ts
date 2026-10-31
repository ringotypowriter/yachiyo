import { createHash, randomUUID } from 'node:crypto'
import { link, mkdir, open, readFile, readdir, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'

export interface PluginStateRecord {
  version: number
  value: z.infer<ReturnType<typeof z.json>>
}

const recordSchema = z.object({ version: z.number().int().positive(), value: z.json() }).strict()
const MAX_RECORD_BYTES = 1024 * 1024

/** Publishes a complete file once. An existing destination is never replaced. */
export async function writeImmutablePluginFile(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`)
  try {
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(text)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await link(temporary, path)
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
    })
  }
}

export class PluginStateConflictError extends Error {
  constructor() {
    super('Plugin state changed concurrently. Read the latest version before writing again.')
    this.name = 'PluginStateConflictError'
  }
}

/** Immutable numbered records make compare-and-set atomic across runtime and CLI processes. */
export class PluginDataStore {
  private readonly directory: string

  constructor(directory: string) {
    this.directory = directory
  }

  private path(key: readonly string[]): string {
    return join(this.directory, createHash('sha256').update(JSON.stringify(key)).digest('hex'))
  }

  async read(key: readonly string[]): Promise<PluginStateRecord> {
    const directory = this.path(key)
    const files = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return []
      throw error
    })
    const latest = files
      .filter((file) => /^\d{16}\.json$/.test(file))
      .sort()
      .at(-1)
    if (!latest) return { version: 0, value: null }
    const record = recordSchema.parse(JSON.parse(await readFile(join(directory, latest), 'utf8')))
    if (record.version !== Number(latest.slice(0, 16))) {
      throw new Error(`Invalid plugin state version in ${join(directory, latest)}`)
    }
    return record
  }

  async write(
    key: readonly string[],
    expectedVersion: number,
    value: unknown
  ): Promise<PluginStateRecord> {
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) {
      throw new Error('expectedVersion must be a nonnegative safe integer')
    }
    const record = recordSchema.parse({ version: expectedVersion + 1, value })
    const text = JSON.stringify(record)
    if (Buffer.byteLength(text) > MAX_RECORD_BYTES) {
      throw new Error('Plugin state records must be at most 1 MiB')
    }
    const current = await this.read(key)
    if (current.version !== expectedVersion) throw new PluginStateConflictError()
    const directory = this.path(key)
    try {
      // link publishes a complete record without replacing a concurrent writer's record.
      await writeImmutablePluginFile(
        join(directory, `${String(record.version).padStart(16, '0')}.json`),
        text
      )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new PluginStateConflictError()
      }
      throw error
    }
    return record
  }
}
