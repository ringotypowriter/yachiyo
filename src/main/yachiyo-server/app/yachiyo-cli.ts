import { randomUUID } from 'node:crypto'
import { connect } from 'node:net'
import { pathToFileURL } from 'node:url'

import type {
  CreateScheduleInput,
  ProviderConfig,
  SettingsConfig,
  SubagentProfile
} from '../../../shared/yachiyo/protocol.ts'
import { ScheduleDomain } from './domain/scheduleDomain.ts'
import { providerMatchesReference } from '../../../shared/yachiyo/providerConfig.ts'
import {
  resolveYachiyoDbPath,
  resolveYachiyoSettingsPath,
  resolveYachiyoSocketPath,
  resolveYachiyoSoulPath
} from '../config/paths.ts'
import {
  readSoulDocument as defaultReadSoulDocument,
  upsertDailySoulTrait as defaultUpsertDailySoulTrait,
  removeSoulTrait as defaultRemoveSoulTrait,
  type SoulDocument,
  type RemoveSoulTraitInput,
  type UpsertDailySoulTraitInput
} from '../runtime/soul.ts'
import { createSettingsStore } from '../settings/settingsStore.ts'
import { YachiyoServerConfigDomain } from './domain/configDomain.ts'
import { searchMessages as defaultSearchMessages, type MessageSearchHit } from './threadSearch.ts'

const USAGE = `Usage: yachiyo <namespace> <subcommand> [args...] [flags...]

All output is JSON unless noted. The app must be running for "send" commands.

── soul ──────────────────────────────────────────────────────────────
  soul traits list                       List evolved personality traits (JSON array of {index, trait}).
  soul traits add <trait>                Append a daily trait. Returns updated list.
  soul traits remove <index-or-text>     Remove trait by numeric index or exact text. Returns updated list.

── provider ──────────────────────────────────────────────────────────
  provider list                          List all configured LLM providers (apiKey is redacted).
  provider show <id-or-name>             Show a single provider by UUID or display name.
  provider update <id-or-name> [--payload <json>]
                                         Merge JSON patch into an existing provider config.
  provider set-default <id-or-name>      Promote a provider to the default slot.
  provider models <id-or-name>           Fetch available model IDs from the provider's API.

── agent ─────────────────────────────────────────────────────────────
  agent list                             List all registered subagent profiles.
  agent show <id-or-name>                Show a single subagent profile.
  agent add --payload <json>             Register a new subagent. Requires "name" and "command" in payload.
  agent update <id-or-name> [--payload <json>]
                                         Merge JSON patch into an existing subagent profile.
  agent remove <id-or-name>              Unregister a subagent profile.
  agent enable <id-or-name>              Enable a disabled subagent.
  agent disable <id-or-name>             Disable a subagent without removing it.

── config ────────────────────────────────────────────────────────────
  config get [path]                      Read the full settings object, or a dot-separated path (e.g. "providers.0.name").
  config set <path> <value>              Write a value at a dot-separated path. Value is parsed as JSON; plain strings are kept as-is.

── thread ────────────────────────────────────────────────────────────
  thread search <query> [--limit <n>] [--json]
                                         Full-text search across message history. Default limit=5.
                                         Without --json, prints human-readable lines.

── schedule ──────────────────────────────────────────────────────────
  schedule list [--json]                 List all cron schedules. Without --json, prints a compact summary.
  schedule add --payload <json>          Create a new schedule. Payload must include cronExpression, name, prompt, etc.
  schedule remove <id>                   Delete a schedule by UUID.
  schedule enable <id>                   Enable a disabled schedule.
  schedule disable <id>                  Disable a schedule without removing it.
  schedule runs [<id>] [--limit <n>] [--json]
                                         List recent schedule runs. Optionally filter by schedule UUID.

── channel ───────────────────────────────────────────────────────────
  channel users [--json]                 List registered channel users with their IDs, platforms, and statuses.
                                         Use the "id" field with "send channel" to send a message.
                                         Without --json, prints a compact summary.
  channel groups [--json]                List registered channel groups with their IDs, platforms, and statuses.
                                         Use the "id" field with "send channel" to send a message.
                                         Without --json, prints a compact summary.

── send (requires running app) ───────────────────────────────────────
  send notification <message> [--title <title>]
                                         Push a native OS notification. Default title="Yachiyo". Fire-and-forget.
  send channel <id> <message>            Send a chat message to a channel user or group by internal UUID.
                                         The app resolves or creates a thread and runs inference. Fire-and-forget.
                                         Get valid IDs from "channel users" or "channel groups".

── Global flags ──────────────────────────────────────────────────────
  --settings <path>   Settings file path      (default: ~/.yachiyo/config.toml)
  --soul <path>       Soul document path      (default: ~/.yachiyo/SOUL.md)
  --db <path>         Database file path       (default: ~/.yachiyo/yachiyo.sqlite)
  --payload <json>    JSON payload for mutation commands
  --limit <n>         Max results to return    (default: 5)
  --json              Output raw JSON instead of human-readable text`

export interface CliConfigService {
  getConfig(): SettingsConfig | Promise<SettingsConfig>
  saveConfig(input: SettingsConfig): SettingsConfig | Promise<SettingsConfig>
  upsertProvider(input: ProviderConfig): ProviderConfig | Promise<ProviderConfig>
  setDefaultProvider(input: {
    id?: string
    name?: string
  }): SettingsConfig | Promise<SettingsConfig>
  fetchProviderModels(input: ProviderConfig): Promise<string[]>
}

export interface RunYachiyoCliOptions {
  createConfigService?: (settingsPath: string) => CliConfigService
  readSoulDocument?: (input: { filePath: string }) => Promise<SoulDocument | null>
  upsertDailySoulTrait?: (input: UpsertDailySoulTraitInput) => Promise<SoulDocument | null>
  removeSoulTrait?: (input: RemoveSoulTraitInput) => Promise<SoulDocument | null>
  searchMessages?: (dbPath: string, query: string, limit: number) => MessageSearchHit[]
  sendNotification?: (
    socketPath: string,
    payload: { title: string; body?: string }
  ) => Promise<void>
  sendChannel?: (
    socketPath: string,
    payload: { type: 'send-channel'; id: string; message: string }
  ) => Promise<void>
  stdout?: Pick<typeof process.stdout, 'write'>
  stderr?: Pick<typeof process.stderr, 'write'>
}

function createDefaultConfigService(settingsPath: string): CliConfigService {
  const settingsStore = createSettingsStore(settingsPath)
  return new YachiyoServerConfigDomain({ settingsStore, emit: () => {} })
}

const VALUE_FLAGS = new Set(['--settings', '--soul', '--payload', '--db', '--limit', '--title'])

function parseArgs(rawArgs: string[]): { positionals: string[]; flags: Map<string, string> } {
  const positionals: string[] = []
  const flags = new Map<string, string>()

  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i]
    if (arg.startsWith('--')) {
      if (VALUE_FLAGS.has(arg)) {
        const value = rawArgs[i + 1]
        if (value !== undefined && !value.startsWith('--')) {
          flags.set(arg, value)
          i++
        }
      } else {
        flags.set(arg, 'true')
      }
    } else {
      positionals.push(arg)
    }
  }

  return { positionals, flags }
}

function outputJson(stdout: Pick<typeof process.stdout, 'write'>, value: unknown): void {
  stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

function sanitizeForOutput(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeForOutput)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        k === 'apiKey' && typeof v === 'string' ? (v ? '***' : '') : sanitizeForOutput(v)
      ])
    )
  }
  return value
}

function findProviderByRef(providers: ProviderConfig[], ref: string): ProviderConfig | undefined {
  return (
    providers.find((p) => providerMatchesReference(p, { id: ref })) ??
    providers.find((p) => providerMatchesReference(p, { name: ref }))
  )
}

function getByPath(obj: unknown, segments: string[]): unknown {
  if (segments.length === 0) return obj
  if (obj === null || obj === undefined) return undefined

  const [head, ...rest] = segments
  const numericHead = /^\d+$/u.test(head) ? parseInt(head, 10) : NaN

  if (Array.isArray(obj) && !isNaN(numericHead)) {
    return getByPath(obj[numericHead], rest)
  }

  if (typeof obj === 'object' && !Array.isArray(obj)) {
    return getByPath((obj as Record<string, unknown>)[head], rest)
  }

  return undefined
}

function setByPath(obj: unknown, segments: string[], value: unknown): unknown {
  if (segments.length === 0) return value

  const [head, ...rest] = segments
  const numericHead = /^\d+$/u.test(head) ? parseInt(head, 10) : NaN

  if (Array.isArray(obj) && !isNaN(numericHead)) {
    const arr = [...obj]
    arr[numericHead] = setByPath(arr[numericHead], rest, value)
    return arr
  }

  if (obj !== null && typeof obj === 'object' && !Array.isArray(obj)) {
    const record = obj as Record<string, unknown>
    return { ...record, [head]: setByPath(record[head], rest, value) }
  }

  if (!isNaN(numericHead)) {
    const arr: unknown[] = []
    arr[numericHead] = setByPath(undefined, rest, value)
    return arr
  }

  return { [head]: setByPath(undefined, rest, value) }
}

function parseConfigValue(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

function formatTraitList(traits: string[]): Array<{ index: number; trait: string }> {
  return traits.map((trait, index) => ({ index, trait }))
}

async function handleSoulCommand(
  positionals: string[],
  soulPath: string,
  stdout: Pick<typeof process.stdout, 'write'>,
  options: RunYachiyoCliOptions
): Promise<void> {
  const subcommand = positionals[0]

  if (subcommand !== 'traits') {
    throw new Error(`Unknown soul subcommand: ${subcommand ?? '(none)'}. Expected: traits`)
  }

  const action = positionals[1]
  const readDoc = options.readSoulDocument ?? defaultReadSoulDocument
  const upsertTrait = options.upsertDailySoulTrait ?? defaultUpsertDailySoulTrait
  const removeTrait = options.removeSoulTrait ?? defaultRemoveSoulTrait

  if (action === 'list') {
    const doc = await readDoc({ filePath: soulPath })
    outputJson(stdout, formatTraitList(doc?.evolvedTraits ?? []))
    return
  }

  if (action === 'add') {
    const traitText = positionals[2]
    if (!traitText?.trim()) {
      throw new Error('Trait text is required: soul traits add "<text>"')
    }
    const doc = await upsertTrait({ filePath: soulPath, trait: traitText })
    outputJson(stdout, {
      added: traitText.trim(),
      traits: formatTraitList(doc?.evolvedTraits ?? [])
    })
    return
  }

  if (action === 'remove') {
    const ref = positionals[2]
    if (ref === undefined) {
      throw new Error('Index or trait text is required: soul traits remove <index-or-text>')
    }
    const numericIndex = /^\d+$/u.test(ref) ? parseInt(ref, 10) : NaN
    const input: RemoveSoulTraitInput = { filePath: soulPath }
    if (!isNaN(numericIndex)) {
      input.index = numericIndex
    } else {
      input.trait = ref
    }
    const doc = await removeTrait(input)
    outputJson(stdout, {
      removed: ref,
      traits: formatTraitList(doc?.evolvedTraits ?? [])
    })
    return
  }

  throw new Error(`Unknown soul traits action: ${action ?? '(none)'}. Expected: list, add, remove`)
}

async function handleProviderCommand(
  positionals: string[],
  flags: Map<string, string>,
  configService: CliConfigService,
  stdout: Pick<typeof process.stdout, 'write'>
): Promise<void> {
  const action = positionals[0]

  if (action === 'list') {
    const config = await configService.getConfig()
    outputJson(
      stdout,
      config.providers.map((p) => sanitizeForOutput(p))
    )
    return
  }

  if (action === 'show') {
    const ref = positionals[1]
    if (!ref) throw new Error('Provider id or name is required: provider show <id-or-name>')
    const config = await configService.getConfig()
    const provider = findProviderByRef(config.providers, ref)
    if (!provider) throw new Error(`Unknown provider: ${ref}`)
    outputJson(stdout, sanitizeForOutput(provider))
    return
  }

  if (action === 'update') {
    const ref = positionals[1]
    if (!ref) throw new Error('Provider id or name is required: provider update <id-or-name>')
    const payloadRaw = flags.get('--payload')
    const patch = payloadRaw ? (JSON.parse(payloadRaw) as Partial<ProviderConfig>) : {}
    const config = await configService.getConfig()
    const existing = findProviderByRef(config.providers, ref)
    if (!existing) throw new Error(`Unknown provider: ${ref}`)
    const updated: ProviderConfig = {
      ...existing,
      ...patch,
      id: existing.id,
      name: patch.name ?? existing.name,
      modelList: patch.modelList
        ? {
            enabled: patch.modelList.enabled ?? existing.modelList.enabled,
            disabled: patch.modelList.disabled ?? existing.modelList.disabled
          }
        : existing.modelList
    }
    const provider = await configService.upsertProvider(updated)
    outputJson(stdout, sanitizeForOutput(provider))
    return
  }

  if (action === 'set-default') {
    const ref = positionals[1]
    if (!ref) throw new Error('Provider id or name is required: provider set-default <id-or-name>')
    const config = await configService.setDefaultProvider({ id: ref, name: ref })
    outputJson(stdout, {
      defaultProvider: config.providers[0] ? sanitizeForOutput(config.providers[0]) : null,
      providers: config.providers.map((p) => sanitizeForOutput(p))
    })
    return
  }

  if (action === 'models') {
    const ref = positionals[1]
    if (!ref) throw new Error('Provider id or name is required: provider models <id-or-name>')
    const config = await configService.getConfig()
    const provider = findProviderByRef(config.providers, ref)
    if (!provider) throw new Error(`Unknown provider: ${ref}`)
    const models = await configService.fetchProviderModels(provider)
    outputJson(stdout, { provider: provider.name, models })
    return
  }

  throw new Error(
    `Unknown provider action: ${action ?? '(none)'}. Expected: list, show, update, set-default, models`
  )
}

function findAgentByRef(profiles: SubagentProfile[], ref: string): SubagentProfile | undefined {
  return profiles.find((p) => p.id === ref) ?? profiles.find((p) => p.name === ref)
}

async function handleAgentCommand(
  positionals: string[],
  flags: Map<string, string>,
  configService: CliConfigService,
  stdout: Pick<typeof process.stdout, 'write'>
): Promise<void> {
  const action = positionals[0]

  if (action === 'list') {
    const config = await configService.getConfig()
    outputJson(stdout, config.subagentProfiles ?? [])
    return
  }

  if (action === 'show') {
    const ref = positionals[1]
    if (!ref) throw new Error('Agent id or name is required: agent show <id-or-name>')
    const config = await configService.getConfig()
    const agent = findAgentByRef(config.subagentProfiles ?? [], ref)
    if (!agent) throw new Error(`Unknown agent: ${ref}`)
    outputJson(stdout, agent)
    return
  }

  if (action === 'add') {
    const payloadRaw = flags.get('--payload')
    if (!payloadRaw) throw new Error('Payload is required: agent add --payload <json>')
    const patch = JSON.parse(payloadRaw) as Partial<SubagentProfile>
    if (!patch.name?.trim()) throw new Error('Agent name is required in payload')
    if (!patch.command?.trim()) throw new Error('Agent command is required in payload')
    const newAgent: SubagentProfile = {
      id: patch.id ?? randomUUID(),
      name: patch.name,
      enabled: patch.enabled ?? true,
      description: patch.description ?? '',
      command: patch.command,
      args: patch.args ?? [],
      env: patch.env ?? {}
    }
    const config = await configService.getConfig()
    const updatedConfig = {
      ...config,
      subagentProfiles: [...(config.subagentProfiles ?? []), newAgent]
    }
    await configService.saveConfig(updatedConfig)
    outputJson(stdout, { added: newAgent, agents: updatedConfig.subagentProfiles })
    return
  }

  if (action === 'update') {
    const ref = positionals[1]
    if (!ref) throw new Error('Agent id or name is required: agent update <id-or-name>')
    const payloadRaw = flags.get('--payload')
    const patch = payloadRaw ? (JSON.parse(payloadRaw) as Partial<SubagentProfile>) : {}
    const config = await configService.getConfig()
    const existing = findAgentByRef(config.subagentProfiles ?? [], ref)
    if (!existing) throw new Error(`Unknown agent: ${ref}`)
    const updated: SubagentProfile = { ...existing, ...patch, id: existing.id }
    const newProfiles = (config.subagentProfiles ?? []).map((p) =>
      p.id === existing.id ? updated : p
    )
    await configService.saveConfig({ ...config, subagentProfiles: newProfiles })
    outputJson(stdout, updated)
    return
  }

  if (action === 'remove') {
    const ref = positionals[1]
    if (!ref) throw new Error('Agent id or name is required: agent remove <id-or-name>')
    const config = await configService.getConfig()
    const existing = findAgentByRef(config.subagentProfiles ?? [], ref)
    if (!existing) throw new Error(`Unknown agent: ${ref}`)
    const newProfiles = (config.subagentProfiles ?? []).filter((p) => p.id !== existing.id)
    await configService.saveConfig({ ...config, subagentProfiles: newProfiles })
    outputJson(stdout, { removed: existing.id, agents: newProfiles })
    return
  }

  if (action === 'enable' || action === 'disable') {
    const ref = positionals[1]
    if (!ref) throw new Error(`Agent id or name is required: agent ${action} <id-or-name>`)
    const config = await configService.getConfig()
    const existing = findAgentByRef(config.subagentProfiles ?? [], ref)
    if (!existing) throw new Error(`Unknown agent: ${ref}`)
    const updated: SubagentProfile = { ...existing, enabled: action === 'enable' }
    const newProfiles = (config.subagentProfiles ?? []).map((p) =>
      p.id === existing.id ? updated : p
    )
    await configService.saveConfig({ ...config, subagentProfiles: newProfiles })
    outputJson(stdout, updated)
    return
  }

  throw new Error(
    `Unknown agent action: ${action ?? '(none)'}. Expected: list, show, add, update, remove, enable, disable`
  )
}

async function handleConfigCommand(
  positionals: string[],
  configService: CliConfigService,
  stdout: Pick<typeof process.stdout, 'write'>
): Promise<void> {
  const action = positionals[0]

  if (action === 'get') {
    const path = positionals[1]
    const config = await configService.getConfig()
    const value = path ? getByPath(config, path.split('.')) : config
    outputJson(stdout, sanitizeForOutput(value))
    return
  }

  if (action === 'set') {
    const path = positionals[1]
    const rawValue = positionals[2]
    if (!path) throw new Error('Path is required: config set <path> <value>')
    if (rawValue === undefined) throw new Error('Value is required: config set <path> <value>')
    const value = parseConfigValue(rawValue)
    const config = await configService.getConfig()
    const updated = setByPath(
      config as unknown as Record<string, unknown>,
      path.split('.'),
      value
    ) as unknown as SettingsConfig
    const saved = await configService.saveConfig(updated)
    outputJson(stdout, {
      path,
      value: sanitizeForOutput(getByPath(saved, path.split('.'))),
      ok: true
    })
    return
  }

  throw new Error(`Unknown config action: ${action ?? '(none)'}. Expected: get, set`)
}

function formatSearchResultsText(hits: MessageSearchHit[]): string {
  if (hits.length === 0) return '(no results)'
  return hits
    .map((h) => {
      const role = h.role === 'assistant' ? 'model' : 'user'
      return `[ThreadID: ${h.threadId}] ${h.date} Role: ${role} Content: ${h.snippet}`
    })
    .join('\n')
}

function handleThreadCommand(
  positionals: string[],
  flags: Map<string, string>,
  dbPath: string,
  stdout: Pick<typeof process.stdout, 'write'>,
  options: RunYachiyoCliOptions
): void {
  const action = positionals[0]
  if (action !== 'search') {
    throw new Error(`Unknown thread action: ${action ?? '(none)'}. Expected: search`)
  }

  const query = positionals[1]
  if (!query?.trim()) {
    throw new Error('Query is required: thread search <query>')
  }

  const limitRaw = flags.get('--limit')
  const limit = limitRaw !== undefined ? parseInt(limitRaw, 10) : 5
  if (isNaN(limit) || limit < 1) {
    throw new Error(`--limit must be a positive integer, got: ${limitRaw}`)
  }

  const useJson = flags.get('--json') === 'true'
  const search = options.searchMessages ?? defaultSearchMessages
  const hits = search(dbPath, query, limit)

  if (useJson) {
    outputJson(stdout, hits)
  } else {
    stdout.write(`${formatSearchResultsText(hits)}\n`)
  }
}

export async function runYachiyoCli(
  args = process.argv.slice(2),
  options: RunYachiyoCliOptions = {}
): Promise<void> {
  const stdout = options.stdout ?? process.stdout
  const { positionals, flags } = parseArgs(args)
  const namespace = positionals[0]

  if (!namespace) {
    throw new Error(USAGE)
  }

  const settingsPath = flags.get('--settings') ?? resolveYachiyoSettingsPath()
  const soulPath = flags.get('--soul') ?? resolveYachiyoSoulPath()
  const dbPath = flags.get('--db') ?? resolveYachiyoDbPath()

  if (namespace === 'soul') {
    await handleSoulCommand(positionals.slice(1), soulPath, stdout, options)
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
    await handleChannelCommand(positionals.slice(1), flags, dbPath, stdout)
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

  await handleConfigCommand(positionals.slice(1), configService, stdout)
}

function defaultSendNotification(
  socketPath: string,
  payload: { title: string; body?: string }
): Promise<void> {
  return new Promise((resolve, reject) => {
    const client = connect(socketPath, () => {
      client.end(JSON.stringify(payload))
    })
    client.on('close', () => resolve())
    client.on('error', (err) => {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ECONNREFUSED') {
        reject(new Error('Yachiyo app is not running. Start the app first to send notifications.'))
      } else {
        reject(err)
      }
    })
  })
}

function defaultSendChannel(
  socketPath: string,
  payload: { type: 'send-channel'; id: string; message: string }
): Promise<void> {
  return new Promise((resolve, reject) => {
    const client = connect(socketPath, () => {
      client.end(JSON.stringify(payload))
    })
    client.on('close', () => resolve())
    client.on('error', (err) => {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ECONNREFUSED') {
        reject(new Error('Yachiyo app is not running. Start the app first.'))
      } else {
        reject(err)
      }
    })
  })
}

async function handleChannelCommand(
  positionals: string[],
  flags: Map<string, string>,
  dbPath: string,
  stdout: Pick<typeof process.stdout, 'write'>
): Promise<void> {
  const action = positionals[0]
  const useJson = flags.get('--json') === 'true'

  const { createSqliteYachiyoStorage } = await import('../storage/sqlite/database.ts')
  const storage = createSqliteYachiyoStorage(dbPath)

  try {
    if (action === 'users') {
      const users = storage.listChannelUsers()
      if (useJson) {
        outputJson(stdout, users)
      } else {
        for (const u of users) {
          stdout.write(`[${u.status}] ${u.platform}:${u.username} id=${u.id}\n`)
        }
        if (users.length === 0) stdout.write('No channel users.\n')
      }
      return
    }

    if (action === 'groups') {
      const groups = storage.listChannelGroups()
      if (useJson) {
        outputJson(stdout, groups)
      } else {
        for (const g of groups) {
          stdout.write(`[${g.status}] ${g.platform}:${g.name} id=${g.id}\n`)
        }
        if (groups.length === 0) stdout.write('No channel groups.\n')
      }
      return
    }

    throw new Error(
      `Unknown channel action: ${action ?? '(none)'}. Expected: users, groups`
    )
  } finally {
    storage.close()
  }
}

async function handleSendCommand(
  positionals: string[],
  flags: Map<string, string>,
  stdout: Pick<typeof process.stdout, 'write'>,
  options: RunYachiyoCliOptions
): Promise<void> {
  const subcommand = positionals[0]

  if (subcommand === 'notification') {
    const body = positionals[1]
    if (!body?.trim()) {
      throw new Error('Message is required: send notification <message> [--title <title>]')
    }
    const title = flags.get('--title') ?? 'Yachiyo'
    const socketPath = resolveYachiyoSocketPath()
    const send = options.sendNotification ?? defaultSendNotification
    await send(socketPath, { title, body })
    stdout.write(`Notification sent.\n`)
    return
  }

  if (subcommand === 'channel') {
    const id = positionals[1]
    const message = positionals[2]
    if (!id?.trim()) {
      throw new Error('Channel user or group ID is required: send channel <id> <message>')
    }
    if (!message?.trim()) {
      throw new Error('Message is required: send channel <id> <message>')
    }
    const socketPath = resolveYachiyoSocketPath()
    const send = options.sendChannel ?? defaultSendChannel
    await send(socketPath, { type: 'send-channel', id, message })
    stdout.write(`Message sent.\n`)
    return
  }

  throw new Error(
    `Unknown send subcommand: ${subcommand ?? '(none)'}. Expected: notification, channel`
  )
}

async function handleScheduleCommand(
  positionals: string[],
  flags: Map<string, string>,
  dbPath: string,
  stdout: Pick<typeof process.stdout, 'write'>
): Promise<void> {
  const { createSqliteYachiyoStorage } = await import('../storage/sqlite/database.ts')
  const storage = createSqliteYachiyoStorage(dbPath)
  const domain = new ScheduleDomain({
    storage,
    createId: () => randomUUID(),
    timestamp: () => new Date().toISOString()
  })

  const action = positionals[0]
  const useJson = flags.get('--json') === 'true'

  if (action === 'list') {
    const schedules = domain.listSchedules()
    if (useJson) {
      outputJson(stdout, schedules)
    } else {
      for (const s of schedules) {
        stdout.write(`${s.enabled ? '✓' : '✗'} ${s.name} [${s.cronExpression}] id=${s.id}\n`)
      }
      if (schedules.length === 0) stdout.write('No schedules.\n')
    }
    storage.close()
    return
  }

  if (action === 'add') {
    const payloadRaw = flags.get('--payload')
    if (!payloadRaw) throw new Error('--payload is required for schedule add')
    const input = JSON.parse(payloadRaw) as CreateScheduleInput
    const schedule = domain.createSchedule(input)
    outputJson(stdout, sanitizeForOutput(schedule))
    storage.close()
    return
  }

  if (action === 'remove') {
    const id = positionals[1]
    if (!id) throw new Error('ID is required: schedule remove <id>')
    domain.deleteSchedule(id)
    stdout.write(`Deleted schedule: ${id}\n`)
    storage.close()
    return
  }

  if (action === 'enable') {
    const id = positionals[1]
    if (!id) throw new Error('ID is required: schedule enable <id>')
    domain.enableSchedule(id)
    stdout.write(`Enabled schedule: ${id}\n`)
    storage.close()
    return
  }

  if (action === 'disable') {
    const id = positionals[1]
    if (!id) throw new Error('ID is required: schedule disable <id>')
    domain.disableSchedule(id)
    stdout.write(`Disabled schedule: ${id}\n`)
    storage.close()
    return
  }

  if (action === 'runs') {
    const scheduleId = positionals[1]
    const limitRaw = flags.get('--limit')
    const limit = limitRaw ? parseInt(limitRaw, 10) : 20
    const runs = scheduleId
      ? domain.listScheduleRuns(scheduleId, limit)
      : domain.listRecentScheduleRuns(limit)

    if (useJson) {
      outputJson(stdout, runs)
    } else {
      for (const r of runs) {
        const status = r.resultStatus ?? r.status
        const summary = r.resultSummary ? ` — ${r.resultSummary.slice(0, 80)}` : ''
        stdout.write(`[${status}] ${r.startedAt}${summary}\n`)
      }
      if (runs.length === 0) stdout.write('No runs.\n')
    }
    storage.close()
    return
  }

  storage.close()
  throw new Error(
    `Unknown schedule action: ${action ?? '(none)'}. Expected: list, add, remove, enable, disable, runs`
  )
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
