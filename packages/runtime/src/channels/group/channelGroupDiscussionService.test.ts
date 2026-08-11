import assert from 'node:assert/strict'
import test from 'node:test'

import type { ChannelGroupRecord, GroupProbeHeadlessAdapterConfig } from '@yachiyo/shared/protocol'
import type { ProviderSettings } from '@yachiyo/shared/protocol'
import { ChannelMessageTooLongError } from '../shared/sendWithUpdateReceipt.ts'
import {
  runGroupProbeHeadlessAdapter,
  sendGroupReplyWithRewriteFallback
} from './channelGroupDiscussionService.ts'
import { CLAUDE_CODE_SEND_GROUP_MESSAGE_TOOL_CALL_ID } from './groupProbeClaudeCode.ts'

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
