// Synthetic fixture, real local RemoteService/Noise/WebSocket transport. Never reads user state.
// Run: node --experimental-strip-types scripts/remote-stream-benchmark.ts [--legacy] [output.json]
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync, deflateRawSync } from 'node:zlib'
import { createFakeDesktopServer } from '../packages/runtime/src/app/host/remote/testing/createFakeDesktopServer.ts'
import { createInProcessRemotePorts } from '../apps/desktop/src/main/remote/inProcessPorts.ts'
import { plaintextSecretBox } from '../apps/desktop/src/main/remote/pairingStore.ts'
import { decodeRemoteMessage } from '../apps/desktop/src/main/remote/messageCodec.ts'
import { RemoteService } from '../apps/desktop/src/main/remote/remoteService.ts'
import { RemoteTestClient } from '../apps/desktop/src/main/remote/testing/remoteTestClient.ts'
import { NoiseTransport } from '../apps/desktop/src/main/remote/noise/transport.ts'
import type { RemotePush } from '../packages/shared/src/remote/events.ts'
import type { RemoteChatAccepted } from '../packages/shared/src/remote/methods.ts'
import type { RemoteThreadSummary } from '../packages/shared/src/remote/projections.ts'
import type WebSocket from 'ws'
import type { Socket } from 'node:net'

type Row = {
  stage: string
  direction: string
  type: string
  plaintextBytes: number
  encodedBytes: number
  compressedMessages: number
  ciphertextBytes: number
  gzipBytes: number
  deflateRawBytes: number
  ciphertextGzipBytes: number
  ciphertextDeflateRawBytes: number
}
const captures: Array<{ stage: string; encoded: Buffer; ciphertext: Buffer }> = []
const args = process.argv.slice(2)
const legacy = args.includes('--legacy')
const outputPaths = args.filter((arg) => arg !== '--legacy')
assert(
  outputPaths.length <= 1 && outputPaths.every((arg) => !arg.startsWith('--')),
  'Usage: remote-stream-benchmark.ts [--legacy] [output.json]'
)
const outputPath = outputPaths[0] ?? join(tmpdir(), 'yachiyo-remote-stream-results.json')
const encrypted = new Map<string, number>()
const decrypted = new Map<string, number>()
const requestMethods = new Map<number, string>()
let stage = 'setup'
function fingerprint(plaintext: Buffer, ciphertext: Buffer): string {
  return createHash('sha256').update(plaintext).update(ciphertext).digest('hex')
}
function increment(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1)
}
const originalEncrypt = NoiseTransport.prototype.encrypt
const originalDecrypt = NoiseTransport.prototype.decrypt
NoiseTransport.prototype.encrypt = function (plaintext: Buffer): Buffer {
  const ciphertext = originalEncrypt.call(this, plaintext)
  captures.push({ stage, encoded: Buffer.from(plaintext), ciphertext: Buffer.from(ciphertext) })
  increment(encrypted, fingerprint(plaintext, ciphertext))
  return ciphertext
}
NoiseTransport.prototype.decrypt = function (ciphertext: Buffer): Buffer {
  const plaintext = originalDecrypt.call(this, ciphertext)
  increment(decrypted, fingerprint(plaintext, ciphertext))
  return plaintext
}
function aggregate(input: Row[]): Record<string, number> {
  const sum = (key: keyof Row): number => input.reduce((total, row) => total + Number(row[key]), 0)
  const plaintextBytes = sum('plaintextBytes')
  const encodedBytes = sum('encodedBytes')
  const ciphertextBytes = sum('ciphertextBytes')
  const uncompressedThenNoiseBytes = plaintextBytes + input.length * 16
  const gzipBytes = sum('gzipBytes')
  const deflateRawBytes = sum('deflateRawBytes')
  return {
    count: input.length,
    plaintextBytes,
    encodedBytes,
    ciphertextBytes,
    compressedMessages: sum('compressedMessages'),
    observedSavedBytes: plaintextBytes - encodedBytes,
    observedEncodingSavingPercent: plaintextBytes ? 100 * (1 - encodedBytes / plaintextBytes) : 0,
    uncompressedThenNoiseBytes,
    observedCiphertextSavingPercent: uncompressedThenNoiseBytes
      ? 100 * (1 - ciphertextBytes / uncompressedThenNoiseBytes)
      : 0,
    gzipBytes,
    deflateRawBytes,
    gzipSavingPercent: plaintextBytes ? 100 * (1 - gzipBytes / plaintextBytes) : 0,
    deflateRawSavingPercent: plaintextBytes ? 100 * (1 - deflateRawBytes / plaintextBytes) : 0,
    estimatedGzipThenNoiseBytes: gzipBytes + input.length * 16,
    estimatedDeflateRawThenNoiseBytes: deflateRawBytes + input.length * 16,
    ciphertextGzipBytes: sum('ciphertextGzipBytes'),
    ciphertextDeflateRawBytes: sum('ciphertextDeflateRawBytes')
  }
}
function groups(
  input: Row[],
  key: 'stage' | 'direction' | 'type'
): Record<string, Record<string, number>> {
  return Object.fromEntries(
    [...new Set(input.map((row) => row[key]))]
      .sort()
      .map((value) => [value, aggregate(input.filter((row) => row[key] === value))])
  )
}
const fake = await createFakeDesktopServer({ demo: false, chunkDelayMs: 15, slowChunkDelayMs: 50 })
const directory = await mkdtemp(join(tmpdir(), 'yachiyo-remote-stream-benchmark-'))
const ports = createInProcessRemotePorts(fake.server)
let endpoint = ''
let client: RemoteTestClient | undefined
const service = new RemoteService({
  directory: join(directory, 'remote'),
  uploadsDirectory: join(directory, 'uploads'),
  secretBox: plaintextSecretBox,
  server: ports.server,
  host: ports.host,
  subscribe: (listener) => fake.server.subscribe(listener),
  listen: { host: '127.0.0.1', port: 0 },
  deviceName: () => 'Synthetic benchmark Mac',
  appVersion: '0.0.0-benchmark',
  endpoints: () => [{ kind: 'lan', url: endpoint }],
  mailboxRoot: null,
  log: () => undefined
})
const socketDeltas: Record<string, { bytesWritten: number; bytesRead: number }> = {}
try {
  await service.start()
  endpoint = `ws://127.0.0.1:${service.port}/remote/v1`
  client = (
    await RemoteTestClient.pair(
      (await service.createPairingUrl()).url,
      legacy ? { compression: false } : {}
    )
  ).client
  assert.equal(client.compression, legacy ? undefined : 'gzip')
  const websocket = (client as unknown as { socket: WebSocket }).socket
  const socket = (websocket as unknown as { _socket: Socket })._socket
  const initialSocket = { bytesWritten: socket.bytesWritten, bytesRead: socket.bytesRead }
  let baseline = initialSocket
  const checkpoint = async (name: string): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 100))
    const now = { bytesWritten: socket.bytesWritten, bytesRead: socket.bytesRead }
    socketDeltas[name] = {
      bytesWritten: now.bytesWritten - baseline.bytesWritten,
      bytesRead: now.bytesRead - baseline.bytesRead
    }
    baseline = now
  }
  await client.call('remote.hello', {
    protocolVersion: 1,
    client: { app: 'yachiyo-node-test', version: '1.0.0' }
  })
  await client.call('threads.list', {})
  const cursor = await client.call<{ epoch: string; headSeq: number }>('events.subscribe', {
    threadIds: []
  })
  await checkpoint('setup')
  const completed = (runId: string) => (push: RemotePush) =>
    push.type === 'event' &&
    push.event.type === 'run.status' &&
    push.event.runId === runId &&
    push.event.status === 'completed'
  stage = 'question'
  const { thread, accepted: asked } = await client.call<{
    thread: RemoteThreadSummary
    accepted: RemoteChatAccepted
  }>('chat.startThread', {
    content: 'ask: continue with the migration?'
  })
  await client.call('events.subscribe', {
    threadIds: [thread.id],
    resumeFrom: { epoch: cursor.epoch, seq: cursor.headSeq }
  })
  const waiting = await client.waitForPush(
    (push) =>
      push.type === 'event' &&
      push.event.type === 'tool.updated' &&
      push.event.toolCall.status === 'waiting-for-user'
  )
  assert(waiting.type === 'event' && waiting.event.type === 'tool.updated')
  await client.call('run.answerToolQuestion', {
    threadId: thread.id,
    runId: asked.runId,
    toolCallId: waiting.event.toolCall.id,
    answer: 'Yes'
  })
  await client.waitForPush(completed(asked.runId))
  await checkpoint('question')
  stage = 'slowStream'
  const slow = await client.call<RemoteChatAccepted>('chat.send', {
    threadId: thread.id,
    content: 'slow: keep streaming while the phone is connected'
  })
  await client.waitForPush(completed(slow.runId))
  await checkpoint('slowStream')
  stage = 'snapshot'
  const detail = await client.call<{ messages: Array<{ content: string }> }>('threads.load', {
    threadId: thread.id
  })
  assert(detail.messages.some((message) => message.content.includes('chunk39')))
  await checkpoint('snapshot')
  // Decode and comparative recompression only after all transport measurements finish.
  const rows: Row[] = []
  for (const { stage, encoded, ciphertext } of captures) {
    const plaintext = await decodeRemoteMessage(encoded, client.compression)
    const message = JSON.parse(plaintext.toString('utf8'))
    if (message.kind === 'rpc:request') requestMethods.set(message.id, message.method)
    const type =
      message.kind === 'rpc:event'
        ? message.payload.type === 'event'
          ? message.payload.event.type
          : message.payload.type
        : `${message.kind}:${message.method ?? requestMethods.get(message.id) ?? 'unknown'}`
    rows.push({
      stage,
      direction: message.kind === 'rpc:request' ? 'phoneToDesktop' : 'desktopToPhone',
      type,
      plaintextBytes: plaintext.length,
      encodedBytes: encoded.length,
      compressedMessages: Number(encoded[0] === 0x01),
      ciphertextBytes: ciphertext.length,
      gzipBytes: gzipSync(plaintext).length,
      deflateRawBytes: deflateRawSync(plaintext).length,
      ciphertextGzipBytes: gzipSync(ciphertext).length,
      ciphertextDeflateRawBytes: deflateRawSync(ciphertext).length
    })
  }
  captures.length = 0
  assert.deepEqual(
    encrypted,
    decrypted,
    'Each ciphertext must be counted once and successfully decrypted once'
  )
  assert(rows.some((row) => row.type === 'message.delta' && row.stage === 'slowStream'))
  assert(rows.every((row) => row.ciphertextBytes === row.encodedBytes + 16))
  const result = {
    generatedAt: new Date().toISOString(),
    mode: legacy ? 'legacy' : 'negotiated',
    negotiatedCompression: client.compression ?? null,
    nodeVersion: process.version,
    fixture:
      'Synthetic scripted model content; real local loopback RemoteService + RemoteTestClient + Noise + WebSocket. NOT actual user phone traffic.',
    isolation:
      'In-memory storage, temporary fake desktop config/workspaces/pairings, mailboxRoot null; no native rebuild.',
    method:
      'Count encrypt only; decrypt SHA-256 multiset equals encrypt multiset. Capture exact encoded envelopes entering Noise; after capture, decode original serialized UTF-8 JSON for plaintextBytes and per-type stats. ciphertextBytes = encodedBytes + 16. Socket deltas from phone TCP socket after pairing handshake to completed snapshot, before close.',
    compression:
      'Observed encoding uses negotiated production codec: unchanged raw JSON or 0x01 + independent gzip; 8 MiB limit. Observed savings compare actual encoded/ciphertext bytes with original JSON/JSON+Noise tag for the same messages, not a separate-run traffic delta. gzipBytes/deflateRawBytes remain default-level offline comparisons only; their +16 estimates omit codec flags/WS framing and production selection thresholds. Ciphertext compression measured separately. No dictionary or context takeover.',
    timingCaveat:
      'Production compression runs before encryption; offline decoding and comparative compression run after capture. Buffer copies and synchronous hash observers can still perturb batching; frame counts are not a production rate estimate. Raw content stays in memory only and is not persisted.',
    scenario: {
      question: 'ask: continue with the migration?',
      answer: 'Yes',
      slow: 'slow: keep streaming while the phone is connected',
      chunks: 40,
      slowChunkDelayMs: 50,
      reconnect: false
    },
    websocketExtensions: websocket.extensions,
    initialSocketCountersIncludingHttpUpgradeAndNoiseHandshake: initialSocket,
    socketDeltas,
    socketTotal: {
      bytesWritten: baseline.bytesWritten - initialSocket.bytesWritten,
      bytesRead: baseline.bytesRead - initialSocket.bytesRead
    },
    totals: aggregate(rows),
    byDirection: groups(rows, 'direction'),
    byType: groups(rows, 'type'),
    byStage: Object.fromEntries(
      [...new Set(rows.map((row) => row.stage))].map((value) => {
        const subset = rows.filter((row) => row.stage === value)
        return [
          value,
          {
            totals: aggregate(subset),
            byDirection: groups(subset, 'direction'),
            byType: groups(subset, 'type')
          }
        ]
      })
    ),
    validation: {
      encryptedMessages: rows.length,
      decryptedMessages: [...decrypted.values()].reduce((a, b) => a + b, 0),
      exactCiphertextRoundTrips: true,
      noiseTagBytesPerMessage: 16
    },
    messages: rows
  }
  await writeFile(outputPath, JSON.stringify(result, null, 2) + '\n')
  console.log(
    JSON.stringify(
      {
        output: outputPath,
        totals: result.totals,
        byDirection: result.byDirection,
        socketTotal: result.socketTotal
      },
      null,
      2
    )
  )
} finally {
  if (client && client.closeCode === null) await client.close()
  await service.stop()
  await fake.dispose()
  await rm(directory, { recursive: true, force: true })
  NoiseTransport.prototype.encrypt = originalEncrypt
  NoiseTransport.prototype.decrypt = originalDecrypt
}
