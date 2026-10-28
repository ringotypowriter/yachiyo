import type {
  AppEventCursor,
  AppEventEnvelope,
  AppEventSubscription
} from '@yachiyo/shared/appServer/protocol'

/** A bounded reconnect window. An expired cursor requires a fresh UI snapshot. */
export class AppEventJournal {
  private sequence = 0
  private bytes = 0
  private entries: { envelope: AppEventEnvelope; bytes: number }[] = []
  private readonly listeners = new Set<(event: AppEventEnvelope) => void>()
  private readonly instanceId: string
  private readonly maxBytes: number
  private readonly maxEvents: number

  constructor(instanceId: string, maxBytes = 16 * 1024 * 1024, maxEvents = 4096) {
    this.instanceId = instanceId
    this.maxBytes = maxBytes
    this.maxEvents = maxEvents
  }

  publish(event: unknown): void {
    const envelope = { cursor: this.cursor(), event: structuredClone(event) }
    envelope.cursor.sequence = ++this.sequence
    const bytes = Buffer.byteLength(JSON.stringify(envelope))
    this.entries.push({ envelope, bytes })
    this.bytes += bytes
    while (this.bytes > this.maxBytes || this.entries.length > this.maxEvents) {
      this.bytes -= this.entries.shift()!.bytes
    }
    for (const listener of this.listeners) listener(envelope)
  }

  cursor(): AppEventCursor {
    return { instanceId: this.instanceId, sequence: this.sequence }
  }

  replay(cursor?: AppEventCursor): AppEventSubscription {
    const oldest = this.entries[0]?.envelope.cursor.sequence ?? this.sequence + 1
    const reset =
      cursor !== undefined &&
      (cursor.instanceId !== this.instanceId ||
        cursor.sequence < oldest - 1 ||
        cursor.sequence > this.sequence)
    return {
      cursor: this.cursor(),
      reset,
      events:
        cursor && !reset
          ? this.entries
              .filter(({ envelope }) => envelope.cursor.sequence > cursor.sequence)
              .map(({ envelope }) => envelope)
          : []
    }
  }

  subscribe(listener: (event: AppEventEnvelope) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}
