import type {
  AppEventCursor,
  AppEventEnvelope,
  AppEventSubscription
} from '@yachiyo/shared/appServer/protocol'
import {
  decodeRpcMessage,
  encodeRpcMessage,
  type RpcWireFrame
} from '@yachiyo/shared/rpc/rpcWireCodec'

/** A bounded reconnect window. An expired cursor requires a fresh UI snapshot. */
export class AppEventJournal {
  private sequence = 0
  private bytes = 0
  private entries: { sequence: number; frame: RpcWireFrame; bytes: number }[] = []
  private readonly listeners = new Set<(frame: RpcWireFrame) => void>()
  private readonly instanceId: string
  private readonly maxBytes: number
  private readonly maxEvents: number

  constructor(instanceId: string, maxBytes = 16 * 1024 * 1024, maxEvents = 4096) {
    this.instanceId = instanceId
    this.maxBytes = maxBytes
    this.maxEvents = maxEvents
  }

  publish(event: unknown): void {
    const sequence = this.sequence + 1
    // Encoding snapshots the value once for retention and every connected client.
    const frame = encodeRpcMessage({
      kind: 'rpc:event',
      payload: { cursor: { instanceId: this.instanceId, sequence }, event }
    })
    const bytes = Buffer.byteLength(frame)
    this.sequence = sequence
    this.entries.push({ sequence, frame, bytes })
    this.bytes += bytes
    while (this.bytes > this.maxBytes || this.entries.length > this.maxEvents) {
      this.bytes -= this.entries.shift()!.bytes
    }
    for (const listener of this.listeners) listener(frame)
  }

  cursor(): AppEventCursor {
    return { instanceId: this.instanceId, sequence: this.sequence }
  }

  replay(cursor?: AppEventCursor): AppEventSubscription {
    const oldest = this.entries[0]?.sequence ?? this.sequence + 1
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
              .filter((entry) => entry.sequence > cursor.sequence)
              .map(({ frame }) => {
                const message = decodeRpcMessage(frame)
                if (message.kind !== 'rpc:event') throw new Error('Invalid journal event')
                return message.payload as AppEventEnvelope
              })
          : []
    }
  }

  /** Frames belong to the journal; subscribers must not modify them. */
  subscribe(listener: (frame: RpcWireFrame) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}
