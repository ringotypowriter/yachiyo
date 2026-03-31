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

function formatTokens(tokens: number, limit: number): string {
  const kTokens = Math.ceil(tokens / 1_000)
  const kLimit = Math.round(limit / 1_000)
  return `${kTokens}k / ${kLimit}k`
}

function modelLabel(thread: ThreadRecord): string {
  return thread.modelOverride?.model ?? 'default'
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
  switch (command) {
    case '/new': {
      await options.createFreshThread(channelUser)
      await options.sendMessage(target, 'New conversation started.')
      return true
    }

    case '/status': {
      const thread = options.server.findActiveChannelThread(
        channelUser.id,
        options.threadReuseWindowMs
      )
      if (!thread) {
        await options.sendMessage(target, 'No active conversation.')
        return true
      }
      const tokens = options.server.getThreadTotalTokens(thread.id)
      const tokenStr = formatTokens(tokens, options.contextTokenLimit)
      await options.sendMessage(target, `Model: ${modelLabel(thread)} · Tokens: ${tokenStr}`)
      return true
    }

    case '/compact': {
      const thread = options.server.findActiveChannelThread(
        channelUser.id,
        options.threadReuseWindowMs
      )
      if (!thread) {
        await options.sendMessage(target, 'No active conversation to compact.')
        return true
      }
      await options.server.compactExternalThread({ threadId: thread.id })
      await options.sendMessage(target, 'Context compacted.')
      return true
    }

    default:
      return false
  }
}
