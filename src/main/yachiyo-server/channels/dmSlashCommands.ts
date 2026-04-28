import { basename } from 'node:path'

import type {
  ChannelUserRecord,
  SettingsConfig,
  ThreadRecord
} from '../../../shared/yachiyo/protocol.ts'
import type { DirectMessageServer } from './directMessageService.ts'

type DmSlashCommandServer = Pick<
  DirectMessageServer,
  'findActiveChannelThread' | 'getThreadTotalTokens' | 'cancelRunForChannelUser'
> & {
  getConfig(): Promise<SettingsConfig>
  hasActiveThread(threadId: string): boolean
  listOwnerDmTakeoverThreads(input: { channelUserId: string; limit: number }): ThreadRecord[]
  takeOverThreadForChannelUser(input: {
    threadId: string
    channelUser: ChannelUserRecord
  }): Promise<ThreadRecord>
  buildThreadTakeoverContext(input: { threadId: string; contextTokenLimit: number }): string
  getThreadWorkspaceChangeBlocker(input: { threadId: string }): string | null
  updateThreadWorkspace(input: {
    threadId: string
    workspacePath?: string | null
  }): Promise<ThreadRecord>
}

export interface DmSlashCommandOptions<TTarget> {
  server: DmSlashCommandServer
  threadReuseWindowMs: number
  contextTokenLimit: number
  pendingChoices?: DmSlashCommandPendingChoiceStore
  createFreshThread(channelUser: ChannelUserRecord): Promise<ThreadRecord>
  sendMessage(target: TTarget, text: string): Promise<void>
  /**
   * Abort any in-flight message handling for the given channel user.
   * Called by commands that invalidate the current run (e.g. /new, /stop).
   */
  requestStop?(channelUserId: string): void
}

type CommandHandler<TTarget> = (
  options: DmSlashCommandOptions<TTarget>,
  target: TTarget,
  channelUser: ChannelUserRecord,
  args: string,
  context: { batchDiscarded: boolean }
) => Promise<void>

interface CommandDef<TTarget> {
  description: string
  handler: CommandHandler<TTarget>
  /** If true, any pending message batch is discarded before the command runs. */
  discardPendingBatch?: boolean
  /** If true, only the owner DM can execute or see this command. */
  ownerOnly?: boolean
}

interface WorkspaceChoice {
  path: string
  label: string
}

export type DmSlashCommandPendingChoice = '/workspace' | '/takeover'

export interface DmSlashCommandPendingChoiceStore {
  get(channelUserId: string): DmSlashCommandPendingChoice | null
  set(
    channelUserId: string,
    command: DmSlashCommandPendingChoice,
    onExpire?: () => void | Promise<void>
  ): void
  delete(channelUserId: string): void
}

export interface DmSlashCommandResolvedChoice {
  command: DmSlashCommandPendingChoice
  args: string
}

export interface DmSlashCommandPendingChoiceStoreOptions {
  ttlMs?: number
  onExpireError?(error: unknown): void
}

interface DmSlashCommandPendingChoiceEntry {
  command: DmSlashCommandPendingChoice
  timeout: ReturnType<typeof setTimeout>
  onExpire?: () => void | Promise<void>
}

const PENDING_CHOICE_TTL_MS = 5 * 60 * 1000
const NUMBER_ONLY_MESSAGE = /^\d+$/
const TAKEOVER_PREVIEW_MAX_LENGTH = 72
const SECTION_DIVIDER = '---'

export function createDmSlashCommandPendingChoiceStore(
  options: DmSlashCommandPendingChoiceStoreOptions = {}
): DmSlashCommandPendingChoiceStore {
  const ttlMs = options.ttlMs ?? PENDING_CHOICE_TTL_MS
  const onExpireError =
    options.onExpireError ??
    ((error: unknown): void => {
      console.error('[dmSlashCommands] pending choice expiry handler failed', error)
    })
  const choices = new Map<string, DmSlashCommandPendingChoiceEntry>()

  const deleteChoice = (channelUserId: string): void => {
    const choice = choices.get(channelUserId)
    if (!choice) {
      return
    }

    clearTimeout(choice.timeout)
    choices.delete(channelUserId)
  }

  return {
    get(channelUserId) {
      return choices.get(channelUserId)?.command ?? null
    },
    set(channelUserId, command, onExpire) {
      deleteChoice(channelUserId)
      const timeout = setTimeout(() => {
        const choice = choices.get(channelUserId)
        if (!choice || choice.timeout !== timeout) {
          return
        }

        choices.delete(channelUserId)
        if (choice.onExpire) {
          void Promise.resolve(choice.onExpire()).catch(onExpireError)
        }
      }, ttlMs)
      choices.set(channelUserId, { command, timeout, onExpire })
    },
    delete(channelUserId) {
      deleteChoice(channelUserId)
    }
  }
}

export function resolvePendingDmSlashCommandChoice(
  pendingChoices: DmSlashCommandPendingChoiceStore,
  channelUser: Pick<ChannelUserRecord, 'id' | 'role'>,
  text: string
): DmSlashCommandResolvedChoice | null {
  const args = text.trim()
  if (channelUser.role !== 'owner' || !NUMBER_ONLY_MESSAGE.test(args)) {
    return null
  }

  const command = pendingChoices.get(channelUser.id)
  return command ? { command, args } : null
}

function rememberPendingChoice<TTarget>(
  options: DmSlashCommandOptions<TTarget>,
  target: TTarget,
  channelUser: ChannelUserRecord,
  command: DmSlashCommandPendingChoice
): void {
  options.pendingChoices?.set(channelUser.id, command, () =>
    options.sendMessage(target, formatPendingChoiceExpired(command))
  )
}

function clearPendingChoice<TTarget>(
  options: DmSlashCommandOptions<TTarget>,
  channelUser: ChannelUserRecord
): void {
  options.pendingChoices?.delete(channelUser.id)
}

function formatDiscardNotice(discarded: boolean): string {
  return discarded ? 'Your unsent message was discarded.\n\n' : ''
}

function formatPendingChoiceExpired(command: DmSlashCommandPendingChoice): string {
  return command === '/workspace'
    ? 'Workspace selection expired. Send /workspace to choose again.'
    : 'Takeover selection expired. Send /takeover to choose again.'
}

function formatPendingChoiceCancelled(command: DmSlashCommandPendingChoice): string {
  return command === '/workspace'
    ? 'Workspace selection cancelled.'
    : 'Takeover selection cancelled.'
}

function formatThreadTitle(thread: Pick<ThreadRecord, 'title' | 'icon'>): string {
  return thread.icon ? `${thread.icon} ${thread.title}` : thread.title
}

function formatTakeoverPreview(preview: string | undefined): string | null {
  const compact = preview?.replace(/\s+/g, ' ').trim()
  if (!compact) {
    return null
  }
  if (compact.length <= TAKEOVER_PREVIEW_MAX_LENGTH) {
    return compact
  }
  const trimmed = compact.slice(0, TAKEOVER_PREVIEW_MAX_LENGTH - 3).trimEnd()
  const wordBoundary = trimmed.lastIndexOf(' ')
  const readable = wordBoundary > 0 ? trimmed.slice(0, wordBoundary) : trimmed
  return `${readable}...`
}

function formatTokens(tokens: number, limit: number): string {
  const used = formatTokenCount(tokens)
  if (limit <= 0) {
    return `${used} / unlimited`
  }

  const normalizedTokens = Math.max(0, tokens)
  const percent = Math.round((normalizedTokens / limit) * 100)
  const remaining = Math.max(0, limit - normalizedTokens)
  return `${used} / ${formatTokenCount(limit)} (${percent}%, ${formatTokenCount(
    remaining
  )} remaining)`
}

function formatTokenCount(tokens: number): string {
  return `${Math.ceil(Math.max(0, tokens) / 1_000)}k`
}

function formatUsage(channelUser: ChannelUserRecord): string {
  const used = `${Math.max(0, channelUser.usedKTokens)}k`
  if (channelUser.usageLimitKTokens == null) {
    return `${used} used`
  }
  return `${used} / ${Math.max(0, channelUser.usageLimitKTokens)}k`
}

function modelLabel(thread: ThreadRecord): string {
  if (!thread.modelOverride) {
    return 'default'
  }
  return `${thread.modelOverride.providerName} / ${thread.modelOverride.model}`
}

function workspaceLabel(path: string, config: SettingsConfig): string {
  const configuredLabel = config.workspace?.pathLabels?.[path]?.trim()
  if (configuredLabel) {
    return configuredLabel
  }
  return basename(path) || path
}

function workspaceChoices(config: SettingsConfig): WorkspaceChoice[] {
  return (config.workspace?.savedPaths ?? []).map((path) => ({
    path,
    label: workspaceLabel(path, config)
  }))
}

function formatWorkspaceChoices(choices: WorkspaceChoice[], currentWorkspacePath?: string): string {
  const lines = ['Saved workspaces:', '']
  choices.forEach((choice, index) => {
    const current = choice.path === currentWorkspacePath ? ' (current)' : ''
    lines.push(`${index + 1}. ${choice.label}${current}`)
    lines.push('')
    lines.push('Path:')
    lines.push(choice.path)
    if (index < choices.length - 1) {
      lines.push('')
      lines.push(SECTION_DIVIDER)
      lines.push('')
    }
  })
  lines.push('')
  lines.push('Reply with a number to switch workspace, or 0 to cancel.')
  return lines.join('\n')
}

function formatTakeoverThreadChoices(threads: ThreadRecord[]): string {
  const lines = ['Threads available to take over:', '']
  threads.forEach((thread, index) => {
    lines.push(`${index + 1}. ${formatThreadTitle(thread)}`)
    const preview = formatTakeoverPreview(thread.preview)
    if (preview) {
      lines.push('')
      lines.push('Preview:')
      lines.push(preview)
    }
    if (index < threads.length - 1) {
      lines.push('')
      lines.push(SECTION_DIVIDER)
      lines.push('')
    }
  })
  lines.push('')
  lines.push('Reply with a number to take over a thread, or 0 to cancel.')
  return lines.join('\n')
}

function formatWorkspaceStatus(path: string, config: SettingsConfig): string {
  const label = workspaceLabel(path, config)
  return label === path ? path : `${label} (${path})`
}

function parseWorkspaceIndex(args: string, choiceCount: number): number | null {
  const trimmed = args.trim()
  if (!/^[1-9]\d*$/.test(trimmed)) {
    return null
  }

  const index = Number(trimmed)
  if (!Number.isSafeInteger(index) || index > choiceCount) {
    return null
  }

  return index - 1
}

function parseTakeoverIndex(args: string, choiceCount: number): number | null {
  const trimmed = args.trim()
  if (!/^[1-9]\d*$/.test(trimmed)) {
    return null
  }

  const index = Number(trimmed)
  if (!Number.isSafeInteger(index) || index > choiceCount) {
    return null
  }

  return index - 1
}

async function handleWorkspaceCommand<TTarget>(
  options: DmSlashCommandOptions<TTarget>,
  target: TTarget,
  channelUser: ChannelUserRecord,
  args: string,
  context: { batchDiscarded: boolean }
): Promise<void> {
  const notice = formatDiscardNotice(context.batchDiscarded)
  if (args.trim() === '0') {
    await options.sendMessage(target, `${notice}${formatPendingChoiceCancelled('/workspace')}`)
    return
  }

  const currentThread = options.server.findActiveChannelThread(
    channelUser.id,
    options.threadReuseWindowMs
  )
  if (currentThread) {
    const blocker = options.server.getThreadWorkspaceChangeBlocker({ threadId: currentThread.id })
    if (blocker) {
      await options.sendMessage(target, `${notice}${blocker}`)
      return
    }
  }

  const config = await options.server.getConfig()
  const choices = workspaceChoices(config)
  if (choices.length === 0) {
    await options.sendMessage(target, `${notice}No saved workspaces configured.`)
    return
  }

  if (!args.trim()) {
    await options.sendMessage(
      target,
      `${notice}${formatWorkspaceChoices(choices, currentThread?.workspacePath)}`
    )
    rememberPendingChoice(options, target, channelUser, '/workspace')
    return
  }

  const selectedIndex = parseWorkspaceIndex(args, choices.length)
  if (selectedIndex === null) {
    await options.sendMessage(
      target,
      `${notice}Choose a workspace number from the list.\n\n${formatWorkspaceChoices(
        choices,
        currentThread?.workspacePath
      )}`
    )
    rememberPendingChoice(options, target, channelUser, '/workspace')
    return
  }

  const selected = choices[selectedIndex]
  const thread = currentThread ?? (await options.createFreshThread(channelUser))

  try {
    await options.server.updateThreadWorkspace({
      threadId: thread.id,
      workspacePath: selected.path
    })
  } catch (error) {
    await options.sendMessage(
      target,
      error instanceof Error ? error.message : 'Failed to switch workspace.'
    )
    return
  }

  await options.sendMessage(
    target,
    `${notice}Workspace switched:\n\n${selected.label}\n\nPath:\n${selected.path}`
  )
}

async function handleTakeoverCommand<TTarget>(
  options: DmSlashCommandOptions<TTarget>,
  target: TTarget,
  channelUser: ChannelUserRecord,
  args: string,
  context: { batchDiscarded: boolean }
): Promise<void> {
  const notice = formatDiscardNotice(context.batchDiscarded)
  if (args.trim() === '0') {
    await options.sendMessage(target, `${notice}${formatPendingChoiceCancelled('/takeover')}`)
    return
  }

  const threads = options.server.listOwnerDmTakeoverThreads({
    channelUserId: channelUser.id,
    limit: 10
  })

  if (threads.length === 0) {
    await options.sendMessage(target, `${notice}No threads available to take over.`)
    return
  }

  if (!args.trim()) {
    await options.sendMessage(target, `${notice}${formatTakeoverThreadChoices(threads)}`)
    rememberPendingChoice(options, target, channelUser, '/takeover')
    return
  }

  const selectedIndex = parseTakeoverIndex(args, threads.length)
  if (selectedIndex === null) {
    await options.sendMessage(
      target,
      `${notice}Choose a thread number from the list.\n\n${formatTakeoverThreadChoices(threads)}`
    )
    rememberPendingChoice(options, target, channelUser, '/takeover')
    return
  }

  const thread = threads[selectedIndex]
  if (options.server.hasActiveThread(thread.id)) {
    await options.sendMessage(target, `${notice}Cannot take over a thread while it is running.`)
    return
  }

  options.requestStop?.(channelUser.id)
  options.server.cancelRunForChannelUser(channelUser.id)

  try {
    await options.server.takeOverThreadForChannelUser({
      threadId: thread.id,
      channelUser
    })
  } catch (error) {
    await options.sendMessage(
      target,
      error instanceof Error ? error.message : 'Failed to take over thread.'
    )
    return
  }

  await options.sendMessage(
    target,
    `${notice}${options.server.buildThreadTakeoverContext({
      threadId: thread.id,
      contextTokenLimit: options.contextTokenLimit
    })}`
  )
}

// Commands are declared here. /help is auto-generated from this map.
const COMMANDS: Record<string, CommandDef<unknown>> = {
  '/new': {
    description: 'Start a new conversation',
    discardPendingBatch: true,
    handler: async (options, target, channelUser, _args, { batchDiscarded }) => {
      await options.createFreshThread(channelUser)
      options.requestStop?.(channelUser.id)
      options.server.cancelRunForChannelUser(channelUser.id)
      const notice = formatDiscardNotice(batchDiscarded)
      await options.sendMessage(target, `${notice}New conversation started.`)
    }
  },

  '/status': {
    description: 'Show current model and token usage',
    handler: async (options, target, channelUser) => {
      const thread = options.server.findActiveChannelThread(
        channelUser.id,
        options.threadReuseWindowMs
      )
      if (!thread) {
        await options.sendMessage(target, 'No active conversation.')
        return
      }
      const tokens = options.server.getThreadTotalTokens(thread.id)
      const lines = [
        'Status:',
        '',
        'Conversation:',
        formatThreadTitle(thread),
        '',
        `State: ${options.server.hasActiveThread(thread.id) ? 'running' : 'idle'}`,
        `Channel: ${channelUser.platform} · ${channelUser.role}`,
        `Model: ${modelLabel(thread)}`,
        `Context: ${formatTokens(tokens, options.contextTokenLimit)}`,
        `Usage: ${formatUsage(channelUser)}`
      ]

      if (channelUser.role === 'owner') {
        const workspace = thread.workspacePath
          ? formatWorkspaceStatus(thread.workspacePath, await options.server.getConfig())
          : 'temporary'
        lines.push('', 'Workspace:', workspace)
      }

      await options.sendMessage(target, lines.join('\n'))
    }
  },

  '/stop': {
    description: 'Force-stop the current run',
    discardPendingBatch: true,
    handler: async (options, target, channelUser, _args, { batchDiscarded }) => {
      const notice = formatDiscardNotice(batchDiscarded)
      options.requestStop?.(channelUser.id)
      const cancelled = options.server.cancelRunForChannelUser(channelUser.id)
      if (cancelled) {
        await options.sendMessage(target, `${notice}Run stopped.`)
      } else {
        await options.sendMessage(target, `${notice}No active run to stop.`)
      }
    }
  },

  '/workspace': {
    description: 'Switch this owner DM thread workspace',
    discardPendingBatch: true,
    ownerOnly: true,
    handler: handleWorkspaceCommand
  },

  '/takeover': {
    description: 'Take over an existing thread',
    discardPendingBatch: true,
    ownerOnly: true,
    handler: handleTakeoverCommand
  },

  '/help': {
    description: 'Show this help message',
    handler: async (options, target, channelUser) => {
      const lines = ['Available commands:', '']
      for (const [name, def] of Object.entries(COMMANDS)) {
        if (def.ownerOnly && channelUser.role !== 'owner') {
          continue
        }
        lines.push(`${name} — ${def.description}`)
      }
      await options.sendMessage(target, lines.join('\n'))
    }
  }
}

export function shouldDiscardPendingBatchForDmCommand(
  command: string,
  channelUser?: Pick<ChannelUserRecord, 'role'>
): boolean {
  const def = COMMANDS[command] as CommandDef<unknown> | undefined
  if (!def?.discardPendingBatch) {
    return false
  }
  if (def.ownerOnly && channelUser?.role !== 'owner') {
    return false
  }
  return true
}

export async function handleDmSlashCommand<TTarget>(
  options: DmSlashCommandOptions<TTarget>,
  target: TTarget,
  channelUser: ChannelUserRecord,
  command: string,
  args: string,
  context: { batchDiscarded: boolean } = { batchDiscarded: false }
): Promise<boolean> {
  if (args) {
    console.log(`[dmSlashCommands] ${command} called with args: ${args}`)
  }
  clearPendingChoice(options, channelUser)

  const def = COMMANDS[command] as CommandDef<TTarget> | undefined
  if (!def) {
    await options.sendMessage(
      target,
      `Unknown command: ${command}.\n\nType /help for a list of commands.`
    )
    return true
  }

  if (def.ownerOnly && channelUser.role !== 'owner') {
    await options.sendMessage(
      target,
      `Unknown command: ${command}.\n\nType /help for a list of commands.`
    )
    return true
  }

  await def.handler(options, target, channelUser, args, context)
  return true
}
