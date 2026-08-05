import type { ChannelSendOptions } from '../../channels/shared/sendWithUpdateReceipt.ts'

export interface SendChannelMessageInput {
  id: string
  message: string
  /** QQBot alone distinguishes a passive reply from an active send. */
  delivery?: 'reply' | 'active'
  /** No platform API call may start at or after this wall-clock time. */
  notAfterMs?: number
}

export interface ChannelMessageTarget {
  platform: 'telegram' | 'qq' | 'discord' | 'qqbot'
  externalId: string
  kind: 'user' | 'group'
}

type StringSender = (target: string, text: string, options?: ChannelSendOptions) => Promise<void>
type NumberSender = (target: number, text: string, options?: ChannelSendOptions) => Promise<void>

export interface ChannelMessageServices {
  telegram: { sendMessage: StringSender } | null
  qq: { sendPrivateMessage: NumberSender; sendGroupMessage: NumberSender } | null
  discord: { sendMessage: StringSender; sendDirectMessage: StringSender } | null
  qqbot: { sendMessage: StringSender; sendActiveMessage: StringSender } | null
}

export async function dispatchChannelMessage(
  target: ChannelMessageTarget,
  input: SendChannelMessageInput,
  services: ChannelMessageServices
): Promise<void> {
  const sendOptions: ChannelSendOptions | undefined =
    input.notAfterMs === undefined ? undefined : { notAfterMs: input.notAfterMs }

  if (target.platform === 'telegram') {
    if (!services.telegram) throw new Error('Telegram service is not running')
    await services.telegram.sendMessage(target.externalId, input.message, sendOptions)
    return
  }

  if (target.platform === 'qq') {
    if (!services.qq) throw new Error('QQ service is not running')
    const numericId = Number(target.externalId)
    if (target.kind === 'user') {
      await services.qq.sendPrivateMessage(numericId, input.message, sendOptions)
    } else {
      await services.qq.sendGroupMessage(numericId, input.message, sendOptions)
    }
    return
  }

  if (target.platform === 'discord') {
    if (!services.discord) throw new Error('Discord service is not running')
    if (target.kind === 'user') {
      await services.discord.sendDirectMessage(target.externalId, input.message, sendOptions)
    } else {
      await services.discord.sendMessage(target.externalId, input.message, sendOptions)
    }
    return
  }

  if (!services.qqbot) throw new Error('QQBot service is not running')
  if (input.delivery === 'active') {
    await services.qqbot.sendActiveMessage(target.externalId, input.message, sendOptions)
  } else {
    await services.qqbot.sendMessage(target.externalId, input.message, sendOptions)
  }
}
