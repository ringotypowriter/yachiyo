import assert from 'node:assert/strict'
import test from 'node:test'

import type { ProviderSettings } from '@yachiyo/shared/protocol'
import type { AuxiliaryTextGenerationResult } from '../../runtime/models/auxiliaryGeneration.ts'
import { GROUP_REPLY_MAX_CHARS } from './groupReplyGuard.ts'
import { rewriteGroupReply } from './groupReplyRewrite.ts'

const settingsOverride = {} as ProviderSettings

const success = (text: string): AuxiliaryTextGenerationResult => ({
  status: 'success',
  text,
  settings: settingsOverride
})

function auxReturning(result: AuxiliaryTextGenerationResult): {
  generateText: () => Promise<AuxiliaryTextGenerationResult>
} {
  return { generateText: async () => result }
}

test('rewriteGroupReply returns the rewritten text', async () => {
  const rewritten = await rewriteGroupReply({
    auxService: auxReturning(success('  这猫脸也太臭了哈哈  ')),
    message: '对，这张像是"我已经很克制了"，太真实了。',
    settingsOverride
  })
  assert.equal(rewritten, '这猫脸也太臭了哈哈')
})

test('rewriteGroupReply strips wrapping quotes and collapses newlines', async () => {
  const rewritten = await rewriteGroupReply({
    auxService: auxReturning(success('"这猫脸\n也太臭了"')),
    message: 'x',
    settingsOverride
  })
  assert.equal(rewritten, '这猫脸 也太臭了')
})

test('rewriteGroupReply returns null when generation is unavailable', async () => {
  const rewritten = await rewriteGroupReply({
    auxService: auxReturning({ status: 'unavailable', reason: 'missing-model' }),
    message: 'x',
    settingsOverride
  })
  assert.equal(rewritten, null)
})

test('rewriteGroupReply returns null when generation throws', async () => {
  const rewritten = await rewriteGroupReply({
    auxService: {
      generateText: async () => {
        throw new Error('boom')
      }
    },
    message: 'x',
    settingsOverride
  })
  assert.equal(rewritten, null)
})

test('rewriteGroupReply returns null when the rewrite is empty', async () => {
  const rewritten = await rewriteGroupReply({
    auxService: auxReturning(success('   ')),
    message: 'x',
    settingsOverride
  })
  assert.equal(rewritten, null)
})

test('rewriteGroupReply returns null when the rewrite is overlong', async () => {
  const rewritten = await rewriteGroupReply({
    auxService: auxReturning(success('字'.repeat(GROUP_REPLY_MAX_CHARS + 1))),
    message: 'x',
    settingsOverride
  })
  assert.equal(rewritten, null)
})

test('rewriteGroupReply returns null when the rewrite has a forbidden prefix', async () => {
  const rewritten = await rewriteGroupReply({
    auxService: auxReturning(success('：这样开头不行')),
    message: 'x',
    settingsOverride
  })
  assert.equal(rewritten, null)
})
