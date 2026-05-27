function encodeSegment(value: string): string {
  return encodeURIComponent(value)
}

function decodeSegment(value: string): string {
  return decodeURIComponent(value)
}

export function folderRowId(folderId: string): string {
  return `thread_folder:${encodeSegment(folderId)}`
}

export function threadRowId(threadId: string): string {
  return `thread:${encodeSegment(threadId)}`
}

export function messageRowId(threadId: string, messageId: string): string {
  return `thread_message:${encodeSegment(threadId)}:${encodeSegment(messageId)}`
}

export function spanRowId(threadId: string, startMessageId: string, endMessageId: string): string {
  return `thread_span:${encodeSegment(threadId)}:${encodeSegment(startMessageId)}:${encodeSegment(endMessageId)}`
}

export function activityRowId(activityId: string): string {
  return `activity_record:${encodeSegment(activityId)}`
}

export function memoryRowId(memoryId: string): string {
  return `memory:${encodeSegment(memoryId)}`
}

export function parseRowId(rowId: string): { kind: string; parts: string[] } {
  const [kind, ...encodedParts] = rowId.split(':')
  return {
    kind,
    parts: encodedParts.map(decodeSegment)
  }
}

export function parseSourceEventSourceRowId(rowId: string): string | undefined {
  const prefix = 'source_event:'
  return rowId.startsWith(prefix) ? rowId.slice(prefix.length) : undefined
}

export function getThreadIdFromRowId(rowId: string | undefined): string | undefined {
  if (!rowId) {
    return undefined
  }
  const parsed = parseRowId(rowId)
  return parsed.kind === 'thread' && parsed.parts.length === 1 ? parsed.parts[0] : undefined
}

export function getFolderIdFromRowId(rowId: string | undefined): string | undefined {
  if (!rowId) {
    return undefined
  }
  const parsed = parseRowId(rowId)
  return parsed.kind === 'thread_folder' && parsed.parts.length === 1 ? parsed.parts[0] : undefined
}

export function parseSpanRowId(
  rowId: string
): { threadId: string; startMessageId: string; endMessageId: string } | null {
  const parsed = parseRowId(rowId)
  if (parsed.kind !== 'thread_span' || parsed.parts.length !== 3) {
    return null
  }
  return {
    threadId: parsed.parts[0]!,
    startMessageId: parsed.parts[1]!,
    endMessageId: parsed.parts[2]!
  }
}
