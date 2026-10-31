import { join } from 'node:path'
import { z } from 'zod'
import { resolveYachiyoPluginsDir } from '../../config/paths.ts'
import {
  PluginDataStore,
  PluginStateConflictError,
  type PluginStateRecord
} from './pluginDataStore.ts'
import type { PluginContext } from './pluginTypes.ts'

const requestSchema = z
  .object({
    operation: z.enum(['read', 'write']),
    scope: z.enum(['run', 'thread', 'workspace', 'plugin']),
    key: z.string().min(1).max(200),
    expectedVersion: z.number().int().nonnegative().optional(),
    value: z.json().optional()
  })
  .strict()

export class PluginState {
  private readonly store: PluginDataStore
  private readonly memory: Map<string, PluginStateRecord>
  private readonly ephemeral: boolean

  constructor(
    options: {
      directory?: string
      memory?: Map<string, PluginStateRecord>
      ephemeral?: boolean
    } = {}
  ) {
    this.store = new PluginDataStore(
      join(options.directory ?? resolveYachiyoPluginsDir(), '.state')
    )
    this.memory = options.memory ?? new Map()
    this.ephemeral = options.ephemeral === true
  }

  async request(name: string, context: PluginContext, input: unknown): Promise<PluginStateRecord> {
    const request = requestSchema.parse(input)
    const scopeId = {
      run: context.runId,
      thread: context.threadId,
      workspace: context.workspacePath,
      plugin: ''
    }[request.scope]
    const key = [name, request.scope, scopeId, request.key]
    const memoryKey = JSON.stringify(key)
    const useMemory = request.scope === 'run' || this.ephemeral
    if (request.operation === 'read') {
      return useMemory
        ? structuredClone(this.memory.get(memoryKey) ?? { version: 0, value: null })
        : this.store.read(key)
    }
    if (request.expectedVersion === undefined || request.value === undefined) {
      throw new Error('State writes require expectedVersion and a JSON value (use null to clear)')
    }
    if (!useMemory) return this.store.write(key, request.expectedVersion, request.value)
    const current = this.memory.get(memoryKey)
    if ((current?.version ?? 0) !== request.expectedVersion) throw new PluginStateConflictError()
    const next = { version: request.expectedVersion + 1, value: request.value }
    if (Buffer.byteLength(JSON.stringify(next)) > 1024 * 1024) {
      throw new Error('Plugin state records must be at most 1 MiB')
    }
    this.memory.set(memoryKey, structuredClone(next))
    return next
  }
}
