export function serializeResponseMessages(responseMessages?: unknown[]): string | null {
  return responseMessages && responseMessages.length > 0 ? JSON.stringify(responseMessages) : null
}

const checkpointMessageJsonCache = new WeakMap<object, string>()

// Checkpoint writes re-serialize the growing run transcript up to ~1.3×/sec
// per active run, all on the runtime's single event loop. During streaming
// only the FINAL response message is ever mutated in place
// (runRecovery.ensureAssistantMessage targets `.at(-1)`), so every earlier
// message is frozen and its JSON can be cached across writes — dropping the
// per-checkpoint cost from O(entire transcript) to O(active tail message).
export function serializeCheckpointResponseMessages(responseMessages?: unknown[]): string | null {
  if (!responseMessages || responseMessages.length === 0) {
    return null
  }
  const parts = responseMessages.map((message, index) => {
    if (index === responseMessages.length - 1 || typeof message !== 'object' || message === null) {
      return JSON.stringify(message) ?? 'null'
    }
    const cached = checkpointMessageJsonCache.get(message)
    if (cached !== undefined) {
      return cached
    }
    const serialized = JSON.stringify(message) ?? 'null'
    checkpointMessageJsonCache.set(message, serialized)
    return serialized
  })
  return `[${parts.join(',')}]`
}

export function parseResponseMessages(value: string | null): unknown[] | undefined {
  if (!value) {
    return undefined
  }

  try {
    const parsed = JSON.parse(value) as unknown[]
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : undefined
  } catch {
    return undefined
  }
}
