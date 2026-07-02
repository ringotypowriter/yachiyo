import assert from 'node:assert/strict'
import test from 'node:test'

import type { ChannelGroupRecord, GroupProbeHeadlessAdapterConfig } from '@yachiyo/shared/protocol'
import type { ProviderSettings } from '@yachiyo/shared/protocol'
import { runGroupProbeHeadlessAdapter } from './channelGroupDiscussionService.ts'
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

test('runGroupProbeHeadlessAdapter drops replay messages when the guarded send is rejected', async () => {
  const result = await runGroupProbeHeadlessAdapter({
    adapter,
    group,
    logLabel: 'group-probe',
    messages: [{ role: 'user', content: '<msg from="Alice">ping</msg>' }],
    sendGroupMessage: async () => 'Rejected: too long for a group chat message.',
    runClaudeCodeProbe: async () => ({
      status: 'success',
      decision: { action: 'send', message: '这段太长了' },
      auxiliaryResult: {
        status: 'success',
        settings,
        text: '{"action":"send","message":"这段太长了"}',
        responseMessages: [
          {
            role: 'assistant',
            content: [
              {
                type: 'tool-call',
                toolCallId: CLAUDE_CODE_SEND_GROUP_MESSAGE_TOOL_CALL_ID,
                toolName: 'send_group_message',
                input: { message: '这段太长了' }
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
