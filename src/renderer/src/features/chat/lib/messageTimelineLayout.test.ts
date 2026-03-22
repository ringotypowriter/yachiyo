import assert from 'node:assert/strict'
import test from 'node:test'

import { buildConversationGroupSectionKinds } from './messageTimelineLayout.ts'

test('buildConversationGroupSectionKinds keeps reply navigation ahead of tool calls when multiple replies exist', () => {
  const sections = buildConversationGroupSectionKinds({
    hasActiveBranch: true,
    hideActiveBranchWhilePreparing: false,
    replyCount: 2,
    showPreparing: false,
    visibleToolCallCount: 1
  })

  assert.deepEqual(sections, ['reply-nav', 'tool-calls', 'assistant-bubble'])
})

test('buildConversationGroupSectionKinds keeps reply navigation visible while a historical retry is preparing', () => {
  const sections = buildConversationGroupSectionKinds({
    hasActiveBranch: true,
    hideActiveBranchWhilePreparing: true,
    replyCount: 2,
    showPreparing: true,
    visibleToolCallCount: 0
  })

  assert.deepEqual(sections, ['reply-nav', 'preparing'])
})
