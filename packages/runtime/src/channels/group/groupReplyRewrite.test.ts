import assert from 'node:assert/strict'
import test from 'node:test'

import type { ProviderSettings } from '@yachiyo/shared/protocol'
import type { AuxiliaryTextGenerationResult } from '../../runtime/models/auxiliaryGeneration.ts'
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
  assert.equal(rewritten, '  这猫脸也太臭了哈哈  ')
})

test('rewriteGroupReply preserves the rewrite instead of mechanically restyling it', async () => {
  const message = `：先说第一句
}再说第二句，${'长一点也是自然聊天。'.repeat(12)}`
  const rewritten = await rewriteGroupReply({
    auxService: auxReturning(success(message)),
    message: 'x',
    settingsOverride
  })
  assert.equal(rewritten, message)
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
