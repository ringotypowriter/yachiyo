import type { ChannelUserRecord, ThreadRecord } from '../../../shared/yachiyo/protocol.ts'
import type { DirectMessageServer } from './directMessageService.ts'

export interface DmSlashCommandOptions<TTarget> {
  server: Pick<
    DirectMessageServer,
    'findActiveChannelThread' | 'compactExternalThread' | 'getThreadTotalTokens'
  >
  threadReuseWindowMs: number
  contextTokenLimit: number
  createFreshThread(channelUser: ChannelUserRecord): Promise<ThreadRecord>
  sendMessage(target: TTarget, text: string): Promise<void>
}

type CommandHandler<TTarget> = (
  options: DmSlashCommandOptions<TTarget>,
  target: TTarget,
  channelUser: ChannelUserRecord,
  args: string
) => Promise<void>

interface CommandDef<TTarget> {
  description: string
  handler: CommandHandler<TTarget>
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
    handler: async (options, target, channelUser) => {
      await options.createFreshThread(channelUser)
      await options.sendMessage(target, 'New conversation started.')
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
    handler: async (options, target, channelUser) => {
      const thread = options.server.findActiveChannelThread(
        channelUser.id,
        options.threadReuseWindowMs
      )
      if (!thread) {
        await options.sendMessage(target, 'No active conversation to compact.')
        return
      }
      await options.server.compactExternalThread({ threadId: thread.id })
      await options.sendMessage(target, 'Context compacted.')
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

export async function handleDmSlashCommand<TTarget>(
  options: DmSlashCommandOptions<TTarget>,
  target: TTarget,
  channelUser: ChannelUserRecord,
  command: string,
  args: string
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

  await def.handler(options, target, channelUser, args)
  return true
}
