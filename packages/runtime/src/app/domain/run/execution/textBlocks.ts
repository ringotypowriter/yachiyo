import type { MessageTextBlockRecord } from '@yachiyo/shared/protocol'

export function appendMessageDeltaToTextBlocks(input: {
  textBlocks: MessageTextBlockRecord[]
  delta: string
  timestamp: string
  createId: () => string
  shouldStartNewBlock: boolean
}): { textBlocks: MessageTextBlockRecord[]; shouldStartNewBlock: boolean } {
  if (!input.delta) {
    return {
      textBlocks: input.textBlocks,
      shouldStartNewBlock: input.shouldStartNewBlock
    }
  }

  const nextTextBlocks = [...input.textBlocks]
  const currentTextBlock =
    !input.shouldStartNewBlock && nextTextBlocks.length > 0 ? nextTextBlocks.at(-1) : undefined

  if (currentTextBlock) {
    nextTextBlocks[nextTextBlocks.length - 1] = {
      ...currentTextBlock,
      content: currentTextBlock.content + input.delta
    }
  } else {
    nextTextBlocks.push({
      id: input.createId(),
      content: input.delta,
      createdAt: input.timestamp
    })
  }

  return {
    textBlocks: nextTextBlocks,
    shouldStartNewBlock: false
  }
}
