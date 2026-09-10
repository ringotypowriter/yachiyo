import assert from 'node:assert/strict'
import test from 'node:test'

import type { ChannelGroupRecord, GroupProbeHeadlessAdapterConfig } from '@yachiyo/shared/protocol'
import type { ProviderSettings } from '@yachiyo/shared/protocol'
import { ChannelMessageTooLongError } from '../shared/sendWithUpdateReceipt.ts'
import {
  runGroupProbeHeadlessAdapter,
  createChannelGroupDiscussionService,
  sendGroupReplyWithRewriteFallback
} from './channelGroupDiscussionService.ts'
import { CLAUDE_CODE_SEND_GROUP_MESSAGE_TOOL_CALL_ID } from './groupProbeClaudeCode.ts'
import { telegramPolicy } from '../shared/channelPolicy.ts'
import type { YachiyoServer } from '../../app/host/YachiyoServer.ts'
import type { GroupMessageEntry } from '@yachiyo/shared/protocol'

test('buffers before enrichment and defers image models across a live switch to mention', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  let saved: GroupMessageEntry[] = []
  let descriptions = 0
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  const service = createChannelGroupDiscussionService({
    platform: 'telegram',
    logLabel: 'test',
    policy: telegramPolicy,
    groupConfig: { enabled: true },
    sendMessage: async () => {},
    server: {
      listChannelGroups: () => [group],
      getStorage: () => ({
        loadGroupMonitorBuffer: () => undefined,
        saveGroupMonitorBuffer: (snapshot: { buffer: GroupMessageEntry[] }) => {
          saved = snapshot.buffer
        },
        deleteGroupMonitorBuffer: () => {}
      }),
      getChannelsConfig: () => ({ imageToText: { enabled: true } }),
      getImageToTextService: () => ({
        describe: async () => {
          descriptions++
          return { altText: 'cat' }
        }
      })
    } as unknown as YachiyoServer
  })
  t.after(() => service.stop())
  const entry: GroupMessageEntry = {
    senderName: 'Alice',
    senderExternalUserId: '1',
    text: 'reply',
    isMention: false,
    timestamp: Date.now() / 1000
  }
  service.routeMessage(group.id, entry, async () => {
    await pending
    return {
      text: 'quoted context\nreply',
      images: [{ dataUrl: 'data:image/png;base64,AAA', mediaType: 'image/png' }]
    }
  })
  t.mock.timers.tick(5000)
  assert.equal(saved[0], entry)
  assert.equal(entry.enrichmentPending, true)
  service.setPreferences({ mode: 'mention' })
  release()
  await pending
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(entry.enrichmentPending, false)
  assert.equal(entry.text, 'quoted context\nreply')
  assert.equal(entry.imageDescriptionDeferred, true)
  assert.equal(descriptions, 0)
})

const settings: ProviderSettings = {
  providerName: 'Claude Code',
  provider: 'anthropic',
  model: 'sonnet',
  apiKey: '',
  baseUrl: ''
}

const adapter: GroupProbeHeadlessAdapterConfig = {
  adapter: 'claude-code',
  providerName: 'Claude Code',
  model: 'sonnet'
}

const group: ChannelGroupRecord = {
  id: 'group-1',
  platform: 'telegram',
  externalGroupId: 'tg-group-1',
  name: 'Test Group',
  label: 'Test Group',
  status: 'approved',
  workspacePath: '/tmp/group-workspace',
  createdAt: '2026-04-21T00:00:00.000Z'
}

test('runGroupProbeHeadlessAdapter drops replay messages when an empty send is rejected', async () => {
  const result = await runGroupProbeHeadlessAdapter({
    adapter,
    group,
    logLabel: 'group-probe',
    messages: [{ role: 'user', content: '<msg from="Alice">ping</msg>' }],
    sendGroupMessage: async () =>
      'Message not sent because it contained no visible text. Send the words you want the group to see.',
    runClaudeCodeProbe: async () => ({
      status: 'success',
      decision: { action: 'send', message: '' },
      auxiliaryResult: {
        status: 'success',
        settings,
        text: '{"action":"send","message":""}',
        responseMessages: [
          {
            role: 'assistant',
            content: [
              {
                type: 'tool-call',
                toolCallId: CLAUDE_CODE_SEND_GROUP_MESSAGE_TOOL_CALL_ID,
                toolName: 'send_group_message',
                input: { message: '' }
              }
            ]
          }
        ]
      }
    })
  })

  assert.equal(result.status, 'success')
  assert.equal(result.responseMessages, undefined)
  assert.equal(result.usage, undefined)
})

test('sendGroupReplyWithRewriteFallback sends the original draft when only the rewrite is too long', async () => {
  const attempts: string[] = []

  const sent = await sendGroupReplyWithRewriteFallback({
    original: 'brief original',
    rewritten: 'expanded rewrite',
    send: async (message) => {
      attempts.push(message)
      if (message === 'expanded rewrite') {
        throw new ChannelMessageTooLongError(12, message.length, 12)
      }
    }
  })

  assert.equal(sent, 'brief original')
  assert.deepEqual(attempts, ['expanded rewrite', 'brief original'])
})

test('sendGroupReplyWithRewriteFallback does not retry an ambiguous delivery failure', async () => {
  const attempts: string[] = []

  await assert.rejects(
    sendGroupReplyWithRewriteFallback({
      original: 'brief original',
      rewritten: 'voice rewrite',
      send: async (message) => {
        attempts.push(message)
        throw new Error('network result unknown')
      }
    }),
    /network result unknown/
  )

  assert.deepEqual(attempts, ['voice rewrite'])
})
