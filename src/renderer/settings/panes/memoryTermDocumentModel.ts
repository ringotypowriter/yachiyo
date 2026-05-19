import type {
  GetMemoryTermDocumentInput,
  MemoryTermDocument,
  MemoryTermEntry,
  MemoryTermTopic,
  SettingsConfig
} from '../../../shared/yachiyo/protocol.ts'

export interface MemoryTermListItem {
  topic: string
  topicEntryCount: number
  entry: MemoryTermEntry
}

export function flattenMemoryTermTopics(topics: readonly MemoryTermTopic[]): MemoryTermListItem[] {
  return topics.flatMap((topic) =>
    topic.entries.map((entry) => ({
      topic: topic.topic,
      topicEntryCount: topic.entryCount,
      entry
    }))
  )
}

export async function loadMemoryTermDocument(
  config?: SettingsConfig,
  page?: Pick<GetMemoryTermDocumentInput, 'limit' | 'offset'>
): Promise<MemoryTermDocument> {
  return window.api.yachiyo.getMemoryTermDocument({
    ...(config ? { config } : {}),
    ...(page ?? {})
  })
}
