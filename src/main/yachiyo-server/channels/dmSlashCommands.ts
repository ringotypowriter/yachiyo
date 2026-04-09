import type { ChannelUserRecord, ThreadRecord } from '../../../shared/yachiyo/protocol.ts'
import type { DirectMessageServer } from './directMessageService.ts'

export interface DmSlashCommandOptions<TTarget> {
  server: Pick<
    DirectMessageServer,
    | 'findActiveChannelThread'
    | 'compactExternalThread'
    | 'getThreadTotalTokens'
    | 'cancelRunForChannelUser'
  >
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
}

function formatTokens(tokens: number, limit: number): string {
  const kTokens = Math.ceil(tokens / 1_000)
  const kLimit = Math.round(limit / 1_000)
  return `${kTokens}k / ${kLimit}k`
}

function modelLabel(thread: ThreadRecord): string {
  return thread.modelOverride?.model ?? 'default'
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
      const tokenStr = formatTokens(tokens, options.contextTokenLimit)
      await options.sendMessage(target, `Model: ${modelLabel(thread)} · Tokens: ${tokenStr}`)
    }
  },

  '/compact': {
    description: 'Compact the conversation context',
    discardPendingBatch: true,
    handler: async (options, target, channelUser, _args, { batchDiscarded }) => {
      const thread = options.server.findActiveChannelThread(
        channelUser.id,
        options.threadReuseWindowMs
      )
      const notice = batchDiscarded ? 'Your unsent message was discarded.\n' : ''
      if (!thread) {
        await options.sendMessage(target, `${notice}No active conversation to compact.`)
        return
      }
      await options.server.compactExternalThread({ threadId: thread.id })
      await options.sendMessage(target, `${notice}Context compacted.`)
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

  '/help': {
    description: 'Show this help message',
    handler: async (options, target) => {
      const lines = ['Available commands:']
      for (const [name, def] of Object.entries(COMMANDS)) {
        lines.push(`${name} — ${def.description}`)
      }
      await options.sendMessage(target, lines.join('\n'))
    }
  }
}

export function shouldDiscardPendingBatchForDmCommand(command: string): boolean {
  const def = COMMANDS[command] as CommandDef<unknown> | undefined
  return def?.discardPendingBatch ?? false
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

  await def.handler(options, target, channelUser, args, context)
  return true
}
