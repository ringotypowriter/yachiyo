#!/usr/bin/env -S pnpm exec tsx
/**
 * Read-only persisted-conversation payload benchmark (no server, pairing or native SQLite).
 * pnpm exec tsx scripts/remote-payload-benchmark.ts [--threads 40] [--iterations 31]
 *   [--db /absolute/path/yachiyo.sqlite] [--out /tmp/yachiyo-remote-payload-results.json]
 * Only aggregates leave memory. Python opens a read-only SQLite snapshot; raw rows travel
 * over a private child-process pipe, never a file. The report intentionally contains no IDs,
 * paths, titles, message contents, hashes of contents, credentials, or ciphertext.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { writeFileSync, readFileSync } from 'node:fs'
import { homedir, cpus } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { gzipSync, gunzipSync, deflateRawSync, inflateRawSync } from 'node:zlib'
import type { RpcMessage } from '../packages/shared/src/rpc/rpcTransport.ts'
import {
  REMOTE_MAX_MESSAGE_BYTES,
  REMOTE_THREAD_PAGE_DEFAULT,
  remoteMethods
} from '../packages/shared/src/remote/methods.ts'
import {
  createRemoteHostOps,
  type RemoteProjectionServer
} from '../packages/runtime/src/app/host/remote/remoteHostOps.ts'
import { createInMemoryYachiyoStorage } from '../packages/runtime/src/storage/memoryStorage.ts'
import {
  toThreadRecord,
  toMessageRecord,
  toRunRecord,
  toToolCallRecord,
  type StoredThreadRow,
  type StoredMessageRow,
  type StoredRunRow,
  type StoredToolCallRow
} from '../packages/runtime/src/storage/storage.ts'
import { HandshakeState } from '../apps/desktop/src/main/remote/noise/handshake.ts'
import { generateKeyPair } from '../apps/desktop/src/main/remote/noise/primitives.ts'
import { NoiseTransport } from '../apps/desktop/src/main/remote/noise/transport.ts'

const args = process.argv.slice(2)
if (args.includes('--help')) {
  console.log(
    'pnpm exec tsx scripts/remote-payload-benchmark.ts [--threads 40] [--iterations 31] [--db PATH] [--out PATH]'
  )
  process.exit(0)
}
const options = new Map<string, string>()
for (let i = 0; i < args.length; i += 2) {
  assert(
    ['--threads', '--iterations', '--db', '--out'].includes(args[i]) && args[i + 1],
    'Invalid CLI arguments'
  )
  options.set(args[i], args[i + 1])
}
const threadCount = Number(options.get('--threads') ?? 40)
const iterations = Number(options.get('--iterations') ?? 31)
assert(Number.isInteger(threadCount) && threadCount >= 1 && threadCount <= 100)
assert(Number.isInteger(iterations) && iterations >= 5 && iterations <= 1000)
const outputPath = options.get('--out') ?? '/tmp/yachiyo-remote-payload-results.json'

// A snapshot transaction includes the WAL, unlike immutable=1 against an active database.
// Exclude provider response transcripts: canonical remote operations never read that column.
const python = String.raw`
import sqlite3, pathlib, json, sys
c = sqlite3.connect(pathlib.Path(sys.argv[1]).resolve().as_uri() + '?mode=ro', uri=True)
c.row_factory = sqlite3.Row
c.execute('PRAGMA query_only=ON')
c.execute('BEGIN')
def rows(sql, params=()):
    return [dict(r) for r in c.execute(sql, params)]
def camel(row):
    return {k.split('_')[0] + ''.join(p.title() for p in k.split('_')[1:]): v for k,v in row.items()}
threads = rows("""SELECT t.* FROM threads t WHERE t.archived_at IS NULL AND
  (((t.source IS NULL OR t.source='local') AND t.channel_user_id IS NULL) OR
   (t.channel_group_id IS NULL AND t.channel_user_id IN
    (SELECT id FROM channel_users WHERE role='owner'))) ORDER BY t.updated_at DESC, t.id""")
selected = [t['id'] for t in threads[:max(100, int(sys.argv[2]))]]
marks = ','.join('?' for _ in selected)
columns = [r['name'] for r in rows('PRAGMA table_info(messages)') if r['name'] != 'response_messages']
messages = rows('SELECT '+','.join(columns)+' FROM messages WHERE thread_id IN ('+marks+') ORDER BY created_at,id', selected)
for m in messages:
    m['response_messages'] = None
    m['hidden'] = bool(m['hidden']) if m['hidden'] is not None else None
runs = rows('SELECT r.* FROM runs r JOIN threads t ON t.id=r.thread_id WHERE t.archived_at IS NULL ORDER BY r.created_at DESC,r.id DESC')
tools = rows('SELECT * FROM tool_calls WHERE thread_id IN ('+marks+') ORDER BY started_at,id', selected)
users = rows("SELECT * FROM channel_users WHERE role='owner'")
print(json.dumps(dict(threads=[camel(r) for r in threads], messages=[camel(r) for r in messages],
 runs=[camel(r) for r in runs], tools=[camel(r) for r in tools], users=[camel(r) for r in users])))
c.rollback()
c.close()
`
const exported = spawnSync(
  'python3',
  [
    '-c',
    python,
    options.get('--db') ?? join(homedir(), '.yachiyo/yachiyo.sqlite'),
    String(threadCount)
  ],
  {
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024
  }
)
// Never echo subprocess stderr/errors: they can contain data or local paths.
assert(
  exported.status === 0 && !exported.error,
  'Read-only SQLite export failed (details suppressed for privacy)'
)
const data = JSON.parse(exported.stdout) as {
  threads: StoredThreadRow[]
  messages: StoredMessageRow[]
  runs: StoredRunRow[]
  tools: StoredToolCallRow[]
  users: Parameters<ReturnType<typeof createInMemoryYachiyoStorage>['createChannelUser']>[0][]
}
exported.stdout = ''
const storage = createInMemoryYachiyoStorage()
for (const user of data.users) storage.createChannelUser(user)
const messages = data.messages.map(toMessageRecord)
const threads = data.threads.map(toThreadRecord)
const runs = data.runs.map(toRunRecord)
for (const thread of threads) {
  storage.createThread({
    thread,
    createdAt: data.threads.find((row) => row.id === thread.id)!.createdAt,
    messages: messages.filter((m) => m.threadId === thread.id)
  })
  // createThread intentionally resets stars for new threads; restore the persisted snapshot.
  storage.updateThread(thread)
}
for (const tool of data.tools) storage.createToolCall(toToolCallRecord(tool))
// Memory storage has no exact run import API. Read-only adapters preserve persisted snapshots
// rather than simulating runs (which would change statuses, request IDs and plan-mode inference).
const bootstrap = storage.bootstrap.bind(storage)
storage.listThreadRuns = (id, options) => {
  const selected = runs.filter((run) => run.threadId === id)
  return options ? selected.slice(0, options.limit) : selected
}
storage.bootstrap = () => ({
  ...bootstrap(),
  latestRunsByThread: Object.fromEntries(
    threads.flatMap((thread) => {
      const latest = storage.listThreadRuns(thread.id, { limit: 1 })[0]
      return latest ? [[thread.id, latest]] : []
    })
  )
})
const unavailable = (): never => {
  throw new Error('Unexpected live-server dependency')
}
const ops = createRemoteHostOps({
  getStorage: () => storage,
  getQueuedFollowUpMessages: () => [], // live run-domain drafts are not reconstructed
  getConfig: unavailable,
  getSyncStatus: unavailable,
  listSubagents: unavailable,
  listBackgroundTasks: unavailable,
  searchThreadsAndMessages: unavailable
} as RemoteProjectionServer)

const keys = generateKeyPair()
const initiator = HandshakeState.initiator({
  pattern: 'IK',
  prologue: Buffer.from('payload-benchmark'),
  staticKeyPair: generateKeyPair(),
  remoteStaticKey: keys.publicKey
})
const responder = HandshakeState.responder({
  pattern: 'IK',
  prologue: Buffer.from('payload-benchmark'),
  staticKeyPair: keys
})
responder.readMessage(initiator.writeMessage(Buffer.alloc(0)))
initiator.readMessage(responder.writeMessage(Buffer.alloc(0)))
const sender = new NoiseTransport(initiator.split())
const receiver = new NoiseTransport(responder.split())
const codecs = [1, 6].flatMap((level) => [
  { name: `gzip${level}`, encode: (b: Buffer) => gzipSync(b, { level }), decode: gunzipSync },
  {
    name: `deflateRaw${level}`,
    encode: (b: Buffer) => deflateRawSync(b, { level }),
    decode: inflateRawSync
  }
])
type Statistics = {
  count: number
  min: number
  median: number
  p95: number
  max: number
  total: number
}
type Timing = { wallMs: { median: number; p95: number }; cpuMs: { median: number; p95: number } }
const stats = (values: number[]): Statistics => {
  const sorted = [...values].sort((a, b) => a - b)
  const percentile = (p: number): number =>
    sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] ?? 0
  return {
    count: sorted.length,
    min: sorted[0] ?? 0,
    median: percentile(0.5),
    p95: percentile(0.95),
    max: sorted.at(-1) ?? 0,
    total: sorted.reduce((a, b) => a + b, 0)
  }
}
function time(fn: () => unknown): Timing {
  for (let i = 0; i < 5; i++) fn()
  const wall: number[] = [],
    cpu: number[] = []
  for (let i = 0; i < iterations; i++) {
    const startCpu = process.cpuUsage(),
      start = performance.now()
    fn()
    wall.push(performance.now() - start)
    const used = process.cpuUsage(startCpu)
    cpu.push((used.user + used.system) / 1000)
  }
  const summarize = (v: number[]): { median: number; p95: number } => ({
    median: stats(v).median,
    p95: stats(v).p95
  })
  return { wallMs: summarize(wall), cpuMs: summarize(cpu) }
}
type Sample = {
  method: string
  sample: number
  rpc: RpcMessage
  fields?: Record<string, number>
  contentBytes?: number
}
const samples: Sample[] = []
const response = (value: unknown): RpcMessage => ({ kind: 'rpc:response', id: 1, ok: true, value })
const list = ops['host.remote.listThreadSummaries']({ limit: 100 })
remoteMethods['threads.list'].output.parse(list)
samples.push({ method: 'threads.list', sample: 1, rpc: response(list) })
const selected = storage.bootstrap().threads.slice(0, threadCount)
let imageCount = 0,
  rejectedImages = 0
for (const [index, thread] of selected.entries()) {
  const detail = ops['host.remote.loadThread']({ threadId: thread.id, limit: 50 })
  remoteMethods['threads.load'].output.parse(detail)
  samples.push({
    method: 'threads.load',
    sample: index + 1,
    rpc: response(detail),
    fields: Object.fromEntries(
      Object.entries(detail).map(([key, value]) => [key, Buffer.byteLength(JSON.stringify(value))])
    )
  })
  for (const m of detail.messages) {
    const stored = storage.getMessage(m.id)!
    for (const [imageIndex] of (stored.images ?? []).entries()) {
      if (imageCount >= 3) break
      try {
        const image = ops['host.remote.getImage']({
          threadId: thread.id,
          messageId: m.id,
          imageId: String(imageIndex)
        })
        samples.push({ method: 'images.get', sample: ++imageCount, rpc: response(image) })
      } catch {
        rejectedImages++
      }
    }
  }
}
const selectedIds = new Set(selected.map((thread) => thread.id))
const users = messages
  .filter((m) => selectedIds.has(m.threadId) && m.role === 'user' && !m.hidden)
  .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  .slice(0, 200)
let invalidChatInputs = 0
for (const [index, user] of users.entries()) {
  const input = { threadId: user.threadId, content: user.content }
  if (!remoteMethods['chat.send'].input.safeParse(input).success) invalidChatInputs++
  samples.push({
    method: 'chat.send',
    sample: index + 1,
    contentBytes: Buffer.byteLength(user.content),
    rpc: { kind: 'rpc:request', id: 1, method: 'chat.send', args: [input] }
  })
}
const measured = samples.map((sample) => {
  const bytes = Buffer.from(JSON.stringify(sample.rpc))
  const oversized = bytes.length > REMOTE_MAX_MESSAGE_BYTES
  let ciphertext: Buffer | undefined
  if (!oversized) {
    ciphertext = sender.encrypt(bytes)
    assert(receiver.decrypt(ciphertext).equals(bytes), 'Noise roundtrip failed')
  }
  const compression = Object.fromEntries(
    codecs.map((codec) => {
      const compressed = codec.encode(bytes)
      assert(codec.decode(compressed).equals(bytes), 'Compression roundtrip failed')
      let encryptedBytes: number | null = null
      if (compressed.length <= REMOTE_MAX_MESSAGE_BYTES) {
        const encrypted = sender.encrypt(compressed)
        assert(
          codec.decode(receiver.decrypt(encrypted)).equals(bytes),
          'Compressed Noise roundtrip failed'
        )
        encryptedBytes = encrypted.length
      }
      return [
        codec.name,
        {
          bytes: compressed.length,
          encryptedBytes,
          ratio: compressed.length / bytes.length,
          // This is diagnostic only: real transport currently encrypts without compression.
          ciphertextCompressedBytes: ciphertext ? codec.encode(ciphertext).length : null
        }
      ]
    })
  )
  return {
    method: sample.method,
    sample: sample.sample,
    jsonBytes: bytes.length,
    noiseBytes: ciphertext?.length ?? null,
    oversized,
    ...(sample.fields ? { fields: sample.fields } : {}),
    ...(sample.contentBytes !== undefined ? { contentBytes: sample.contentBytes } : {}),
    compression
  }
})
const methods = [...new Set(samples.map((s) => s.method))]
const representatives = methods.flatMap((method) => {
  const group = measured
    .filter((s) => s.method === method)
    .sort((a, b) => a.jsonBytes - b.jsonBytes)
  return [...new Set([0, Math.floor((group.length - 1) / 2), group.length - 1])].map((rank) => {
    const item = group[rank],
      sample = samples.find((s) => s.method === method && s.sample === item.sample)!
    const bytes = Buffer.from(JSON.stringify(sample.rpc))
    const noiseTimings = !item.oversized
      ? time(() => {
          const encrypted = sender.encrypt(bytes)
          receiver.decrypt(encrypted)
        })
      : null
    const compression = Object.fromEntries(
      codecs.map((codec) => {
        const compressed = codec.encode(bytes)
        return [
          codec.name,
          {
            encode: time(() => codec.encode(bytes)),
            decode: time(() => codec.decode(compressed)),
            compressedNoiseRoundtrip:
              compressed.length <= REMOTE_MAX_MESSAGE_BYTES
                ? time(() => {
                    const encoded = codec.encode(bytes)
                    const encrypted = sender.encrypt(encoded)
                    codec.decode(receiver.decrypt(encrypted))
                  })
                : null
          }
        ]
      })
    )
    return {
      method,
      sample: item.sample,
      sizeRank: rank + 1,
      groupCount: group.length,
      jsonBytes: bytes.length,
      stringify: time(() => JSON.stringify(sample.rpc)),
      noiseEncryptDecrypt: noiseTimings,
      compression
    }
  })
})
const report = {
  version: 1,
  generatedAt: new Date().toISOString(),
  environment: {
    node: process.version,
    zlib: process.versions.zlib,
    platform: process.platform,
    arch: process.arch,
    cpu: cpus()[0]?.model
  },
  parameters: {
    requestedThreads: threadCount,
    selectedThreads: selected.length,
    listLimit: 100,
    loadLimit: 50,
    canonicalDefaultLoadLimit: REMOTE_THREAD_PAGE_DEFAULT,
    iterations,
    warmups: 5,
    chatSamples: users.length,
    images: imageCount
  },
  dataset: {
    activeBootstrapThreads: threads.length,
    hydratedMessageCount: messages.length,
    hydratedToolCallCount: data.tools.length,
    sampledUserContentBytes: stats(users.map((m) => Buffer.byteLength(m.content))),
    invalidChatInputs,
    rejectedImages
  },
  boundaries: [
    'Read-only SQLite snapshot; no app, native rebuild, production state changes or network connections.',
    'Canonical row converters, in-memory storage, createRemoteHostOps projections and RPC envelopes; list100 and current-branch load50. Actual stored strings are measured, not anonymized before compression.',
    'Exact persisted run snapshots supplied through read-only storage adapters. Live queued follow-up drafts absent; persisted running statuses may differ from live runtime.',
    'Bodies/tool calls hydrated for newest100 bootstrap-visible active threads; no provider response transcripts, config, credentials or raw exports written.',
    'chat.send replays text-only request shape from latest200 visible persisted user messages in selected threads; no sending, attachment upload, new-message timing or send response modeled. Invalid current-schema inputs counted, not silently excluded.',
    'At most3 images from first pages measured with canonical images.get; not a representative image survey.',
    'Post-handshake NoiseTransport encryption is real, with ephemeral in-memory keys. Sizes exclude handshake, WebSocket/TCP/TLS/relay framing and network latency.',
    'Compression is hypothetical per-message before Noise; existing production transport does not compress. No context takeover. Ciphertext compression is diagnostic.',
    'CPU is process.cpuUsage user+system; wall is performance.now, synchronous in-process, 5 warmups; CPU resolution/GC/scheduling affect small samples. Noise timing combines encrypt+decrypt, not a one-way latency.',
    'Aggregates only; no persisted IDs, content, paths, ciphertext or hashes emitted. Snapshot and machine load can change between runs.'
  ],
  summary: Object.fromEntries(
    methods.map((method) => {
      const group = measured.filter((s) => s.method === method)
      return [
        method,
        {
          jsonBytes: stats(group.map((s) => s.jsonBytes)),
          noiseBytes: stats(group.flatMap((s) => (s.noiseBytes === null ? [] : [s.noiseBytes]))),
          compression: Object.fromEntries(
            codecs.map((codec) => [
              codec.name,
              stats(group.map((s) => s.compression[codec.name].bytes))
            ])
          )
        }
      ]
    })
  ),
  samples: measured,
  representatives,
  allRoundtripsVerified: true
}
writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
assert.deepEqual(JSON.parse(readFileSync(outputPath, 'utf8')), report)
console.log(
  JSON.stringify(
    {
      parameters: report.parameters,
      dataset: report.dataset,
      summary: report.summary,
      allRoundtripsVerified: true
    },
    null,
    2
  )
)
storage.close()
