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
  const lines = ['Saved workspaces:']
  choices.forEach((choice, index) => {
    const current = choice.path === currentWorkspacePath ? ' (current)' : ''
    lines.push(`${index + 1}. ${choice.label}${current}`)
    lines.push(`   ${choice.path}`)
  })
  lines.push('Send /workspace 1, /workspace 2, etc. to switch.')
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

async function handleWorkspaceCommand<TTarget>(
  options: DmSlashCommandOptions<TTarget>,
  target: TTarget,
  channelUser: ChannelUserRecord,
  args: string,
  context: { batchDiscarded: boolean }
): Promise<void> {
  const notice = context.batchDiscarded ? 'Your unsent message was discarded.\n' : ''
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
    return
  }

  const selectedIndex = parseWorkspaceIndex(args, choices.length)
  if (selectedIndex === null) {
    await options.sendMessage(
      target,
      `${notice}Choose a workspace number from the list.\n${formatWorkspaceChoices(
        choices,
        currentThread?.workspacePath
      )}`
    )
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
    `${notice}Workspace switched to ${selected.label}.\n${selected.path}`
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
      const notice = batchDiscarded ? 'Your unsent message was discarded.\n' : ''
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
        `Conversation: ${thread.title}`,
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
        lines.push(`Workspace: ${workspace}`)
      }

      await options.sendMessage(target, lines.join('\n'))
    }
  },

  '/stop': {
    description: 'Force-stop the current run',
    discardPendingBatch: true,
    handler: async (options, target, channelUser, _args, { batchDiscarded }) => {
      const notice = batchDiscarded ? 'Your unsent message was discarded.\n' : ''
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

  '/help': {
    description: 'Show this help message',
    handler: async (options, target, channelUser) => {
      const lines = ['Available commands:']
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

  const def = COMMANDS[command] as CommandDef<TTarget> | undefined
  if (!def) {
    await options.sendMessage(
      target,
      `Unknown command: ${command}. Type /help for a list of commands.`
    )
    return true
  }

  if (def.ownerOnly && channelUser.role !== 'owner') {
    await options.sendMessage(
      target,
      `Unknown command: ${command}. Type /help for a list of commands.`
    )
    return true
  }

  await def.handler(options, target, channelUser, args, context)
  return true
}
