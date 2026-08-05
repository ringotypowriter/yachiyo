import assert from 'node:assert/strict'
import test from 'node:test'

import { dispatchChannelMessage } from './channelMessageDispatch.ts'

test('forwards one dispatch deadline through every channel route', async () => {
  const calls: Array<{ route: string; target: string | number; notAfterMs?: number }> = []
  const capture =
    (route: string) =>
    async (
      target: string | number,
      _text: string,
      options?: { notAfterMs?: number }
    ): Promise<void> => {
      calls.push({ route, target, notAfterMs: options?.notAfterMs })
    }
  const services = {
    telegram: { sendMessage: capture('telegram') },
    qq: {
      sendPrivateMessage: capture('qq-private'),
      sendGroupMessage: capture('qq-group')
    },
    discord: {
      sendMessage: capture('discord-group'),
      sendDirectMessage: capture('discord-direct')
    },
    qqbot: {
      sendMessage: capture('qqbot-reply'),
      sendActiveMessage: capture('qqbot-active')
    }
  }
  const input = { id: 'chan-1', message: 'hello', notAfterMs: 123 }

  await dispatchChannelMessage(
    { platform: 'telegram', externalId: 'tg-1', kind: 'user' },
    input,
    services
  )
  await dispatchChannelMessage({ platform: 'qq', externalId: '42', kind: 'user' }, input, services)
  await dispatchChannelMessage({ platform: 'qq', externalId: '43', kind: 'group' }, input, services)
  await dispatchChannelMessage(
    { platform: 'discord', externalId: 'dc-1', kind: 'group' },
    input,
    services
  )
  await dispatchChannelMessage(
    { platform: 'discord', externalId: 'dc-user-1', kind: 'user' },
    input,
    services
  )
  await dispatchChannelMessage(
    { platform: 'qqbot', externalId: 'qb-1', kind: 'user' },
    input,
    services
  )
  await dispatchChannelMessage(
    { platform: 'qqbot', externalId: 'qb-2', kind: 'user' },
    { ...input, delivery: 'active' },
    services
  )

  assert.deepEqual(calls, [
    { route: 'telegram', target: 'tg-1', notAfterMs: 123 },
    { route: 'qq-private', target: 42, notAfterMs: 123 },
    { route: 'qq-group', target: 43, notAfterMs: 123 },
    { route: 'discord-group', target: 'dc-1', notAfterMs: 123 },
    { route: 'discord-direct', target: 'dc-user-1', notAfterMs: 123 },
    { route: 'qqbot-reply', target: 'qb-1', notAfterMs: 123 },
    { route: 'qqbot-active', target: 'qb-2', notAfterMs: 123 }
  ])
})
