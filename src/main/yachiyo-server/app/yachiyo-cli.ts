import { randomUUID } from 'node:crypto'
import { connect } from 'node:net'
import { pathToFileURL } from 'node:url'

import type {
  ChannelGroupStatus,
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
import {
  searchMessages as defaultSearchMessages,
  listRecentThreads as defaultListRecentThreads,
  dumpThread as defaultDumpThread,
  type MessageSearchHit,
  type ThreadSummary,
  type ThreadDump
} from './threadSearch.ts'
import type { YachiyoStorage } from '../storage/storage.ts'

const GLOBAL_FLAGS_HELP = `Global flags:
  --settings <path>   Settings file path      (default: ~/.yachiyo/config.toml)
  --soul <path>       Soul document path      (default: ~/.yachiyo/SOUL.md)
  --db <path>         Database file path       (default: ~/.yachiyo/yachiyo.sqlite)
  --payload <json>    JSON payload for mutation commands
  --limit <n>         Max results to return    (default: 5)
  --json              Output raw JSON instead of human-readable text
  --help              Show help for a command or namespace`

const NAMESPACE_HELP: Record<string, string> = {
  soul: `Usage: yachiyo soul <subcommand> [args...]

  soul traits list                       List evolved personality traits (JSON array of {index, trait}).
  soul traits add <trait>                Append a daily trait. Returns updated list.
  soul traits remove <index-or-text>     Remove trait by numeric index or exact text. Returns updated list.`,

  provider: `Usage: yachiyo provider <action> [args...] [flags...]

  provider list                          List all configured LLM providers (apiKey is redacted).
  provider show <id-or-name>             Show a single provider by UUID or display name.
  provider update <id-or-name> [--payload <json>]
                                         Merge JSON patch into an existing provider config.
  provider set-default <id-or-name> [--model <model>]
                                         Promote a provider to default and set the active model.
                                         Without --model, picks the first enabled model.
  provider models [id-or-name]           Without argument: list all locally enabled models.
                                         With argument: fetch available model IDs from the provider's API.`,

  agent: `Usage: yachiyo agent <action> [args...] [flags...]

  agent list                             List all registered subagent profiles.
  agent show <id-or-name>                Show a single subagent profile.
  agent add --payload <json>             Register a new subagent. Requires "name" and "command" in payload.
  agent update <id-or-name> [--payload <json>]
                                         Merge JSON patch into an existing subagent profile.
  agent remove <id-or-name>              Unregister a subagent profile.
  agent enable <id-or-name>              Enable a disabled subagent.
  agent disable <id-or-name>             Disable a subagent without removing it.`,

  config: `Usage: yachiyo config <action> [args...]

  config get [path]                      Read the full settings object, or a dot-separated path (e.g. "providers.0.name").
  config set <path> <value>              Write a value at a dot-separated path. Value is parsed as JSON; plain strings are kept as-is.`,

  thread: `Usage: yachiyo thread <action> [args...] [flags...]

  thread search <query> [--limit <n>] [--json] [--include-private]
                                         Full-text search across message history. Default limit=5.
                                         Without --json, prints human-readable lines.
                                         Privacy-mode threads are hidden unless --include-private is set.
  thread list [--limit <n>] [--json] [--include-private]
                                         List recent (non-archived) threads ordered by updatedAt desc.
                                         Each entry includes the thread's first user query and preview.
                                         Default limit=10. Privacy-mode threads are hidden unless
                                         --include-private is set.
  thread show <id> [--json] [--include-private]
                                         Dump all messages of a thread in chronological order.
                                         Privacy-mode threads are hidden unless --include-private is set.`,

  schedule: `Usage: yachiyo schedule <action> [args...] [flags...]

  schedule list [--json]                 List all schedules. Without --json, prints a compact summary.
  schedule add --payload <json>          Create a new schedule. Payload must include name and prompt, plus either
                                         cronExpression (recurring) or runAt (ISO datetime, one-off).
  schedule remove <id>                   Delete a schedule by UUID.
  schedule enable <id>                   Enable a disabled schedule.
  schedule disable <id>                  Disable a schedule without removing it.
  schedule runs [<id>] [--limit <n>] [--json]
                                         List recent schedule runs. Optionally filter by schedule UUID.`,

  channel: `Usage: yachiyo channel <action> [args...] [flags...]

  channel users [--json]                 List registered channel users with their IDs, platforms, and statuses.
                                         Use the "id" field with "send channel" to send a message.
                                         Without --json, prints a compact summary.
  channel users set-label <id> <label>   Set a descriptive label on a channel user.
                                         Labels help the agent identify who each contact is.
  channel groups [--json]                List registered channel groups with their IDs, platforms, and statuses.
                                         Use the "id" field with "send channel" to send a message.
                                         Without --json, prints a compact summary.
  channel groups set-status <id> <status>
                                         Update only a group channel's monitor status.
                                         Accepted statuses: approved|approval, pending, blocked|block.
  channel groups set-label <id> <label>  Set a descriptive label on a channel group.
                                         Labels help the agent understand the group's context.`,

  send: `Usage: yachiyo send <subcommand> [args...] [flags...]

  Requires the app to be running.

  send notification <message> [--title <title>]
                                         Push a native OS notification. Default title="Yachiyo". Fire-and-forget.
  send channel <id> <message>            Send a text message directly to a channel user or group on their
                                         external platform (Telegram/QQ/Discord) as the bot. No thread or
                                         inference — the message goes straight out. Fire-and-forget.
                                         Get valid IDs from "channel users" or "channel groups".`
}

function namespaceHelp(ns: string): string {
  return `${NAMESPACE_HELP[ns]}\n\n${GLOBAL_FLAGS_HELP}`
}

const USAGE = `Usage: yachiyo <namespace> <subcommand> [args...] [flags...]

All output is JSON unless noted. The app must be running for "send" commands.
Use "yachiyo <namespace> --help" for detailed help on a specific namespace.

Namespaces: soul, provider, agent, config, thread, schedule, channel, send

${Object.values(NAMESPACE_HELP).join('\n\n')}\n\n${GLOBAL_FLAGS_HELP}`

export interface CliConfigService {
  getConfig(): SettingsConfig | Promise<SettingsConfig>
  saveConfig(input: SettingsConfig): SettingsConfig | Promise<SettingsConfig>
  upsertProvider(input: ProviderConfig): ProviderConfig | Promise<ProviderConfig>
  setDefaultProvider(input: {
    id?: string
    name?: string
    model?: string
  }): SettingsConfig | Promise<SettingsConfig>
  fetchProviderModels(input: ProviderConfig): Promise<string[]>
}

export interface RunYachiyoCliOptions {
  createConfigService?: (settingsPath: string) => CliConfigService
  createStorage?: (dbPath: string) => YachiyoStorage
  readSoulDocument?: (input: { filePath: string }) => Promise<SoulDocument | null>
  upsertDailySoulTrait?: (input: UpsertDailySoulTraitInput) => Promise<SoulDocument | null>
  removeSoulTrait?: (input: RemoveSoulTraitInput) => Promise<SoulDocument | null>
  searchMessages?: (
    dbPath: string,
    query: string,
    limit: number,
    includePrivate: boolean
  ) => MessageSearchHit[]
  listRecentThreads?: (dbPath: string, limit: number, includePrivate: boolean) => ThreadSummary[]
  dumpThread?: (dbPath: string, threadId: string, includePrivate: boolean) => ThreadDump | null
  sendNotification?: (
    socketPath: string,
    payload: { title: string; body?: string }
  ) => Promise<void>
  sendChannel?: (
    socketPath: string,
    payload: { type: 'send-channel'; id: string; message: string }
  ) => Promise<void>
  sendChannelGroupStatus?: (
    socketPath: string,
    payload: {
      type: 'update-channel-group-status'
      id: string
      status: ChannelGroupStatus
    }
  ) => Promise<void>
  sendChannelGroupLabel?: (
    socketPath: string,
    payload: {
      type: 'update-channel-group-label'
      id: string
      label: string
    }
  ) => Promise<void>
  sendMarkThreadReviewed?: (
    socketPath: string,
    payload: { type: 'mark-thread-reviewed'; threadId: string }
  ) => Promise<void>
  stdout?: Pick<typeof process.stdout, 'write'>
  stderr?: Pick<typeof process.stderr, 'write'>
}

function createDefaultConfigService(settingsPath: string): CliConfigService {
  const settingsStore = createSettingsStore(settingsPath)
  return new YachiyoServerConfigDomain({ settingsStore, emit: () => {} })
}

const VALUE_FLAGS = new Set([
  '--settings',
  '--soul',
  '--payload',
  '--db',
  '--limit',
  '--title',
  '--model'
])

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
  flags: Map<string, string>,
  soulPath: string,
  stdout: Pick<typeof process.stdout, 'write'>,
  options: RunYachiyoCliOptions
): Promise<void> {
  if (flags.has('--help')) {
    stdout.write(`${namespaceHelp('soul')}\n`)
    return
  }

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
  if (flags.has('--help')) {
    stdout.write(`${namespaceHelp('provider')}\n`)
    return
  }

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
    const model = flags.get('--model')
    const config = await configService.setDefaultProvider({ id: ref, name: ref, model })
    outputJson(stdout, {
      defaultProvider: config.providers[0] ? sanitizeForOutput(config.providers[0]) : null,
      defaultModel: config.defaultModel ?? null,
      providers: config.providers.map((p) => sanitizeForOutput(p))
    })
    return
  }

  if (action === 'models') {
    const ref = positionals[1]
    const config = await configService.getConfig()

    if (!ref) {
      const enabled = config.providers.flatMap((p) =>
        p.modelList.enabled.map((model) => ({ provider: p.name, model }))
      )
      outputJson(stdout, enabled)
      return
    }

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
  if (flags.has('--help')) {
    stdout.write(`${namespaceHelp('agent')}\n`)
    return
  }

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
  flags: Map<string, string>,
  configService: CliConfigService,
  stdout: Pick<typeof process.stdout, 'write'>
): Promise<void> {
  if (flags.has('--help')) {
    stdout.write(`${namespaceHelp('config')}\n`)
    return
  }

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

function parseChannelGroupStatus(raw: string): ChannelGroupStatus {
  switch (raw.trim().toLowerCase()) {
    case 'approved':
    case 'approval':
    case 'approve':
      return 'approved'
    case 'pending':
      return 'pending'
    case 'blocked':
    case 'block':
      return 'blocked'
    default:
      throw new Error(
        `Invalid group monitor status: ${raw}. Expected one of: approved, approval, pending, blocked, block`
      )
  }
}

function parseLimitFlag(flags: Map<string, string>, fallback: number): number {
  const raw = flags.get('--limit')
  const limit = raw !== undefined ? parseInt(raw, 10) : fallback
  if (isNaN(limit) || limit < 1) {
    throw new Error(`--limit must be a positive integer, got: ${raw}`)
  }
  return limit
}

function formatThreadListText(threads: ThreadSummary[]): string {
  if (threads.length === 0) return '(no threads)'
  return threads
    .map((t) => {
      const firstQ = t.firstUserQuery ?? '(no user message)'
      const updated = t.updatedAt.slice(0, 19).replace('T', ' ')
      const reviewed = t.selfReviewedAt ? ' [reviewed]' : ''
      return `[${t.threadId}] ${updated} (${t.messageCount} msgs)${reviewed} ${t.title}\n  q: ${firstQ}`
    })
    .join('\n')
}

function formatThreadDumpText(dump: ThreadDump): string {
  const header = `Thread ${dump.threadId}: ${dump.title}\nUpdated: ${dump.updatedAt}  Messages: ${dump.messages.length}`
  if (dump.messages.length === 0) return `${header}\n(no messages)`
  const body = dump.messages
    .map((m) => {
      const role = m.role === 'assistant' ? 'model' : m.role
      const ts = m.createdAt.slice(0, 19).replace('T', ' ')
      return `── ${role} @ ${ts} [${m.messageId}] ──\n${m.content}`
    })
    .join('\n\n')
  return `${header}\n\n${body}`
}

function handleThreadCommand(
  positionals: string[],
  flags: Map<string, string>,
  dbPath: string,
  stdout: Pick<typeof process.stdout, 'write'>,
  options: RunYachiyoCliOptions
): void {
  if (flags.has('--help')) {
    stdout.write(`${namespaceHelp('thread')}\n`)
    return
  }

  const action = positionals[0]
  const useJson = flags.get('--json') === 'true'
  const includePrivate = flags.has('--include-private')

  if (action === 'search') {
    const query = positionals[1]
    if (!query?.trim()) {
      throw new Error('Query is required: thread search <query>')
    }
    const limit = parseLimitFlag(flags, 5)
    const search = options.searchMessages ?? defaultSearchMessages
    const hits = search(dbPath, query, limit, includePrivate)

    if (useJson) {
      outputJson(stdout, hits)
    } else {
      stdout.write(`${formatSearchResultsText(hits)}\n`)
    }
    return
  }

  if (action === 'list') {
    const limit = parseLimitFlag(flags, 10)
    const list = options.listRecentThreads ?? defaultListRecentThreads
    const threads = list(dbPath, limit, includePrivate)

    if (useJson) {
      outputJson(stdout, threads)
    } else {
      stdout.write(`${formatThreadListText(threads)}\n`)
    }
    return
  }

  if (action === 'show') {
    const threadId = positionals[1]
    if (!threadId?.trim()) {
      throw new Error('Thread id is required: thread show <id>')
    }
    const dumpFn = options.dumpThread ?? defaultDumpThread
    const dump = dumpFn(dbPath, threadId, includePrivate)

    if (!dump) {
      throw new Error(`Thread not found: ${threadId}`)
    }

    if (useJson) {
      outputJson(stdout, dump)
    } else {
      stdout.write(`${formatThreadDumpText(dump)}\n`)
    }

    // Best-effort: notify running app to mark thread as reviewed via UDS
    const sendReviewed = options.sendMarkThreadReviewed ?? defaultSendMarkThreadReviewed
    const socketPath = resolveYachiyoSocketPath()
    sendReviewed(socketPath, { type: 'mark-thread-reviewed', threadId }).catch(() => {})

    return
  }

  throw new Error(`Unknown thread action: ${action ?? '(none)'}. Expected: search, list, show`)
}

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

function defaultSendChannelGroupStatus(
  socketPath: string,
  payload: {
    type: 'update-channel-group-status'
    id: string
    status: ChannelGroupStatus
  }
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

function defaultSendChannelGroupLabel(
  socketPath: string,
  payload: {
    type: 'update-channel-group-label'
    id: string
    label: string
  }
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

function defaultSendMarkThreadReviewed(
  socketPath: string,
  payload: { type: 'mark-thread-reviewed'; threadId: string }
): Promise<void> {
  return new Promise((resolve, reject) => {
    const client = connect(socketPath, () => {
      client.end(JSON.stringify(payload))
    })
    client.on('close', () => resolve())
    client.on('error', (err) => {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ECONNREFUSED') {
        // App not running — best-effort, silently resolve
        resolve()
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
  stdout: Pick<typeof process.stdout, 'write'>,
  options: RunYachiyoCliOptions
): Promise<void> {
  if (flags.has('--help')) {
    stdout.write(`${namespaceHelp('channel')}\n`)
    return
  }

  const action = positionals[0]
  const useJson = flags.get('--json') === 'true'

  const storage =
    options.createStorage ??
    (async () => {
      const { createSqliteYachiyoStorage } = await import('../storage/sqlite/database.ts')
      return createSqliteYachiyoStorage(dbPath)
    })
  const channelStorage = typeof storage === 'function' ? await storage(dbPath) : storage

  try {
    if (action === 'users') {
      const subcommand = positionals[1]

      if (subcommand === 'set-label') {
        const id = positionals[2]
        const label = positionals.slice(3).join(' ')
        if (!id?.trim()) {
          throw new Error('User ID is required: channel users set-label <id> <label>')
        }

        const updated = channelStorage.updateChannelUser({ id, label })
        if (!updated) {
          throw new Error(`Unknown channel user: ${id}`)
        }
        outputJson(stdout, updated)
        return
      }

      if (subcommand !== undefined) {
        throw new Error(
          `Unknown channel users action: ${subcommand}. Expected: set-label or no subcommand`
        )
      }

      const users = channelStorage.listChannelUsers()
      if (useJson) {
        outputJson(stdout, users)
      } else {
        for (const u of users) {
          const labelPart = u.label ? ` "${u.label}"` : ''
          stdout.write(`[${u.status}] ${u.platform}:${u.username}${labelPart} id=${u.id}\n`)
        }
        if (users.length === 0) stdout.write('No channel users.\n')
      }
      return
    }

    if (action === 'groups') {
      const subcommand = positionals[1]

      if (subcommand === 'set-status') {
        const id = positionals[2]
        const rawStatus = positionals[3]
        let liveAppNotified = true
        if (!id?.trim()) {
          throw new Error('Group ID is required: channel groups set-status <id> <status>')
        }
        if (!rawStatus?.trim()) {
          throw new Error('Status is required: channel groups set-status <id> <status>')
        }

        const status = parseChannelGroupStatus(rawStatus)
        const socketPath = resolveYachiyoSocketPath()
        const sendStatus = options.sendChannelGroupStatus ?? defaultSendChannelGroupStatus

        try {
          await sendStatus(socketPath, { type: 'update-channel-group-status', id, status })
        } catch (error) {
          const code =
            error && typeof error === 'object' ? (error as NodeJS.ErrnoException).code : ''
          const message = error instanceof Error ? error.message : String(error)
          const canFallback =
            code === 'ENOENT' ||
            code === 'ECONNREFUSED' ||
            code === 'EPERM' ||
            message.includes('not running')
          if (!canFallback) {
            throw error
          }
          liveAppNotified = false
        }

        const updated = channelStorage.updateChannelGroup({ id, status })
        if (!updated) {
          throw new Error(`Unknown channel group: ${id}`)
        }

        if (!liveAppNotified) {
          options.stderr?.write(
            'Updated the stored group status, but the running app was not notified. Restart Yachiyo to apply it immediately.\n'
          )
        }

        outputJson(stdout, updated)
        return
      }

      if (subcommand === 'set-label') {
        const id = positionals[2]
        const label = positionals.slice(3).join(' ')
        let liveAppNotified = true
        if (!id?.trim()) {
          throw new Error('Group ID is required: channel groups set-label <id> <label>')
        }

        const socketPath = resolveYachiyoSocketPath()
        const sendLabel = options.sendChannelGroupLabel ?? defaultSendChannelGroupLabel

        try {
          await sendLabel(socketPath, { type: 'update-channel-group-label', id, label })
        } catch (error) {
          const code =
            error && typeof error === 'object' ? (error as NodeJS.ErrnoException).code : ''
          const message = error instanceof Error ? error.message : String(error)
          const canFallback =
            code === 'ENOENT' ||
            code === 'ECONNREFUSED' ||
            code === 'EPERM' ||
            message.includes('not running')
          if (!canFallback) {
            throw error
          }
          liveAppNotified = false
        }

        const updated = channelStorage.updateChannelGroup({ id, label })
        if (!updated) {
          throw new Error(`Unknown channel group: ${id}`)
        }

        if (!liveAppNotified) {
          options.stderr?.write(
            'Updated the stored group label, but the running app was not notified. Restart Yachiyo to apply it immediately.\n'
          )
        }

        outputJson(stdout, updated)
        return
      }

      if (subcommand !== undefined) {
        throw new Error(
          `Unknown channel groups action: ${subcommand}. Expected: set-status, set-label, or no subcommand`
        )
      }

      const groups = channelStorage.listChannelGroups()
      if (useJson) {
        outputJson(stdout, groups)
      } else {
        for (const g of groups) {
          const labelPart = g.label ? ` "${g.label}"` : ''
          stdout.write(`[${g.status}] ${g.platform}:${g.name}${labelPart} id=${g.id}\n`)
        }
        if (groups.length === 0) stdout.write('No channel groups.\n')
      }
      return
    }

    throw new Error(`Unknown channel action: ${action ?? '(none)'}. Expected: users, groups`)
  } finally {
    channelStorage.close()
  }
}

async function handleSendCommand(
  positionals: string[],
  flags: Map<string, string>,
  stdout: Pick<typeof process.stdout, 'write'>,
  options: RunYachiyoCliOptions
): Promise<void> {
  if (flags.has('--help')) {
    stdout.write(`${namespaceHelp('send')}\n`)
    return
  }

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
  if (flags.has('--help')) {
    stdout.write(`${namespaceHelp('schedule')}\n`)
    return
  }

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
        const scheduleLabel = s.runAt ? `@${s.runAt}` : (s.cronExpression ?? '?')
        stdout.write(`${s.enabled ? '✓' : '✗'} ${s.name} [${scheduleLabel}] id=${s.id}\n`)
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
