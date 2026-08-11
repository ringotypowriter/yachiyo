import type { ProviderSettings } from '@yachiyo/shared/protocol'
import type { AuxiliaryGenerationService } from '../../runtime/models/auxiliaryGeneration.ts'
import { GROUP_REPLY_REWRITE_SYSTEM_PROMPT, buildGroupReplyRewritePrompt } from './groupPrompts.ts'
import { prepareGroupReplyForDelivery } from './groupReplyContent.ts'

export interface RewriteGroupReplyInput {
  auxService: Pick<AuxiliaryGenerationService, 'generateText'>
  message: string
  settingsOverride: ProviderSettings
}

/**
 * Voice pass: rewrite an outgoing group reply into the persona's chat voice
 * with the configured rewrite model. Returns the rewritten text, or null when
 * the result is empty — callers fall back to the original
 * message, so a flaky rewriter can never silence the bot.
 */
export async function rewriteGroupReply(input: RewriteGroupReplyInput): Promise<string | null> {
  let result
  try {
    result = await input.auxService.generateText({
      messages: [
        { role: 'system', content: GROUP_REPLY_REWRITE_SYSTEM_PROMPT },
        { role: 'user', content: buildGroupReplyRewritePrompt(input.message) }
      ],
      settingsOverride: input.settingsOverride,
      purpose: 'group-reply-rewrite'
    })
  } catch {
    return null
  }
  if (result.status !== 'success') {
    return null
  }

  return prepareGroupReplyForDelivery(result.text)
}
