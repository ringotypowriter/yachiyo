import type { AuxiliaryTextGenerationResult } from '../../runtime/models/auxiliaryGeneration.ts'
import type { ModelMessage } from '../../runtime/models/types.ts'
import { prepareGroupReplyForDelivery } from './groupReplyContent.ts'

export interface GroupReplyGeneration {
  result: AuxiliaryTextGenerationResult
  reply: string | null
}

export interface GroupReplyDelivery {
  sentText?: string
  /** Only a confirmed pre-delivery rejection may request a correction. */
  retry?: string
}

type SuccessfulGeneration = Extract<AuxiliaryTextGenerationResult, { status: 'success' }>

function mergeCorrection(
  previous: SuccessfulGeneration,
  current: SuccessfulGeneration,
  rejection: string
): SuccessfulGeneration {
  const usage = current.usage ? { ...current.usage } : previous.usage
  if (usage && previous.usage && current.usage) {
    for (const key of [
      'totalPromptTokens',
      'totalCompletionTokens',
      'modelGenerationDurationMs',
      'cacheReadTokens',
      'cacheWriteTokens'
    ] as const) {
      if (previous.usage[key] !== undefined || current.usage[key] !== undefined) {
        usage[key] = (previous.usage[key] ?? 0) + (current.usage[key] ?? 0)
      }
    }
    usage.initialPromptTokens = previous.usage.initialPromptTokens
  }
  const responseMessages = [
    ...(previous.responseMessages ??
      previous.usage?.responseMessages ?? [{ role: 'assistant', content: previous.text }]),
    { role: 'user', content: rejection },
    ...(current.responseMessages ??
      current.usage?.responseMessages ?? [{ role: 'assistant', content: current.text }])
  ]
  return {
    ...current,
    responseMessages,
    ...(usage ? { usage: { ...usage, responseMessages } } : {})
  }
}

export function extractFinalGroupReply(result: AuxiliaryTextGenerationResult): string | null {
  if (result.status !== 'success' || result.usage?.finishReason !== 'stop') return null
  const messages = result.responseMessages ?? result.usage.responseMessages
  const last = messages?.at(-1) as ModelMessage | undefined
  if (last?.role !== 'assistant') return null
  if (typeof last.content === 'string') return prepareGroupReplyForDelivery(last.content)
  if (last.content.some((part) => part.type === 'tool-call')) return null
  return prepareGroupReplyForDelivery(
    last.content
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('')
  )
}

export async function runGroupReplyTurn(input: {
  messages: ModelMessage[]
  generate: (messages: ModelMessage[], staySilent: () => void) => Promise<GroupReplyGeneration>
  send: (message: string) => Promise<GroupReplyDelivery>
}): Promise<{
  result: AuxiliaryTextGenerationResult
  previousResult?: SuccessfulGeneration
  sentText?: string
}> {
  let silent = false
  let messages = input.messages
  let previousResult: SuccessfulGeneration | undefined
  let rejection = ''
  for (let attempt = 0; ; attempt++) {
    const generation = await input.generate(messages, () => {
      silent = true
    })
    if (generation.result.status !== 'success') return { result: generation.result, previousResult }
    const { reply } = generation
    const result = previousResult
      ? mergeCorrection(previousResult, generation.result, rejection)
      : generation.result
    const prepared = reply === null ? null : prepareGroupReplyForDelivery(reply)
    if (silent || prepared === null) return { result }
    const delivery = await input.send(prepared)
    if (delivery.sentText !== undefined) return { result, sentText: delivery.sentText }
    if (attempt > 0 || !delivery.retry) return { result }
    previousResult = result
    rejection = delivery.retry
    messages = [
      ...messages,
      { role: 'assistant', content: prepared },
      { role: 'user', content: delivery.retry }
    ]
  }
}
