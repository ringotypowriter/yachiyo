/** Retains the latest 1024 identities; evicted replays and unkeyed notifications may notify again. */
export function createNotificationDeduplicator(): (key?: string) => boolean {
  const seen = new Set<string>()
  return (key) => {
    if (!key) return true
    if (seen.has(key)) return false
    seen.add(key)
    if (seen.size > 1024) seen.delete(seen.values().next().value!)
    return true
  }
}
