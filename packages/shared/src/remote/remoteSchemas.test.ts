import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import type { MessageRecord } from '../protocol.ts'

import { remoteEventSchema, remotePushSchema } from './events.ts'
import { remoteEndpointSchema } from './common.ts'
import { buildRemoteProtocolJsonSchema } from './jsonSchema.ts'
import { projectMessage, projectThreadSummary, projectToolCall } from './project.ts'
import { mailboxPlaintextSchema } from './mailbox.ts'
import { REMOTE_METHOD_NAMES, remoteMethods } from './methods.ts'
import {
  decodePairingUrl,
  encodePairingUrl,
  handshakeClientPayloadSchema,
  pairingPayloadSchema,
  pairingGrantSchema,
  type PairingPayload
} from './pairing.ts'
import {
  remoteMessageSchema,
  remoteThreadDetailSchema,
  type RemoteMessage,
  type RemoteThreadSummary
} from './projections.ts'

const KEY = 'A'.repeat(43)

test('remote thread summary exposes the persisted mode rather than a run snapshot', () => {
  const summary = projectThreadSummary(
    { id: 'thread-1', title: 'Thread', runMode: 'plan', updatedAt: '2026-05-02T00:00:00.000Z' },
    { needsAttention: false }
  )
  assert.equal(summary.runMode, 'plan')
})

test('relay bearer is separate from a WSS phone base URL and can accompany an encrypted grant', () => {
  const relayEndpoint = {
    kind: 'relay' as const,
    url: 'wss://relay.example/v1/phones/mac-1/phone-1/ws',
    token: KEY
  }
  assert.deepEqual(remoteEndpointSchema.parse(relayEndpoint), relayEndpoint)
  assert.deepEqual(
    pairingPayloadSchema.parse(pairingPayload({ endpoints: [relayEndpoint] })).endpoints,
    [relayEndpoint]
  )
  assert.deepEqual(
    pairingGrantSchema.parse({
      type: 'pairing.granted',
      pairingId: 'phone-1',
      mailboxSecret: KEY,
      relayEndpoint
    }).relayEndpoint,
    relayEndpoint
  )
  assert.equal(
    remoteEndpointSchema.safeParse({
      ...relayEndpoint,
      url: 'ws://relay.example/v1/phones/mac-1/phone-1/ws'
    }).success,
    false
  )
  assert.equal(
    remoteEndpointSchema.safeParse({
      ...relayEndpoint,
      url: `wss://relay.example/v1/phones/mac-1/phone-1/ws?token=${KEY}`
    }).success,
    false
  )
})

function pairingPayload(overrides: Partial<PairingPayload> = {}): PairingPayload {
  return {
    v: 1,
    remoteDeviceId: '0123456789abcdef0123456789abcdef',
    deviceName: 'Studio Mac',
    desktopKey: KEY,
    token: 'B'.repeat(43),
    endpoints: [
      { kind: 'tunnel', url: 'wss://quiet-fox.trycloudflare.com/remote/v1' },
      { kind: 'lan', url: 'ws://192.168.1.20:47831/remote/v1' }
    ],
    expiresAt: '2026-09-22T12:05:00.000Z',
    ...overrides
  }
}

const summary: RemoteThreadSummary = {
  id: 'thread-1',
  title: 'Refactor sync',
  starred: false,
  updatedAt: '2026-09-22T12:00:00.000Z',
  workspaceName: 'yachiyo',
  latestRun: { runId: 'run-1', status: 'running', startedAt: '2026-09-22T11:59:00.000Z' },
  needsAttention: true,
  preview: 'Which branch should I use?',
  capabilities: {
    canRetry: true,
    canCreateBranch: true,
    canSelectReplyBranch: true,
    canEdit: true,
    canSend: true
  }
}

const message: RemoteMessage = {
  id: 'message-1',
  role: 'assistant',
  content: 'Done.',
  images: [{ imageId: '0', mediaType: 'image/png' }],
  attachments: [],
  status: 'completed',
  createdAt: '2026-09-22T12:00:00.000Z',
  siblingIds: ['message-0', 'message-1'],
  isPlanDocument: false
}

test('tool deck summary survives projection and a summary-only remote event', () => {
  const toolCall = projectToolCall({
    id: 'tool-1',
    threadId: 'thread-1',
    runId: 'run-1',
    toolName: 'read',
    status: 'completed',
    inputSummary: '/tmp/a',
    deckSummary: 'Reading files',
    startedAt: '2026-09-22T12:00:00.000Z'
  })
  assert.equal(toolCall.deckSummary, 'Reading files')
  const event = remoteEventSchema.parse({
    type: 'tool.updated',
    threadId: 'thread-1',
    runId: 'run-1',
    summaryOnly: true,
    toolCall
  })
  assert.equal(event.type === 'tool.updated' && event.summaryOnly, true)
  assert.equal(event.type === 'tool.updated' && event.toolCall.deckSummary, 'Reading files')
})

test('remote message preserves assistant text blocks across a JSON round trip', () => {
  const blocks = [
    { id: 'before', content: 'Before tool', createdAt: '2026-09-22T12:00:00.000Z' },
    { id: 'after', content: 'After tool', createdAt: '2026-09-22T12:00:02.000Z' }
  ]
  const decoded = remoteMessageSchema.parse(
    JSON.parse(JSON.stringify({ ...message, textBlocks: blocks }))
  )
  assert.deepEqual(decoded.textBlocks, blocks)
  const source: MessageRecord = {
    id: message.id,
    threadId: 'thread-1',
    role: 'assistant',
    content: 'Before toolAfter tool',
    status: 'completed',
    createdAt: message.createdAt,
    textBlocks: blocks,
    responseMessages: [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Before tool' },
          { type: 'tool-call', toolCallId: 'tool-1', toolName: 'read', input: {} }
        ]
      },
      {
        role: 'tool',
        content: [{ type: 'tool-result', toolCallId: 'tool-1', toolName: 'read', output: 'ok' }]
      },
      { role: 'assistant', content: [{ type: 'text', text: 'After tool' }] }
    ]
  }
  const projected = projectMessage(source)
  assert.deepEqual(projected?.textBlocks, blocks)
  assert.deepEqual(projected?.contentOrder, ['before', 'tool-1', 'after'])
  assert.deepEqual(remoteMessageSchema.parse(projected).contentOrder, ['before', 'tool-1', 'after'])
})

function roundTrip<T>(schema: { parse(value: unknown): T }, value: T): void {
  const parsed = schema.parse(value)
  const reparsed = schema.parse(JSON.parse(JSON.stringify(parsed)))
  assert.deepEqual(reparsed, parsed)
  assert.deepEqual(parsed, value)
}

test('pairing URL encodes and decodes the QR payload losslessly', () => {
  const payload = pairingPayload()
  const url = encodePairingUrl(payload)

  assert.match(url, /^yachiyo-remote:\/\/pair\?v=1&d=[A-Za-z0-9_-]+$/)
  assert.deepEqual(decodePairingUrl(url), payload)
})

test('handshake compression capabilities are optional and bounded', () => {
  const legacy = { deviceName: 'Phone', app: 'test', version: '1' }
  roundTrip(handshakeClientPayloadSchema, legacy)
  roundTrip(handshakeClientPayloadSchema, { ...legacy, compression: ['gzip', 'future-codec'] })
  assert.equal(
    handshakeClientPayloadSchema.safeParse({ ...legacy, compression: 'gzip' }).success,
    false
  )
  assert.equal(
    handshakeClientPayloadSchema.safeParse({ ...legacy, compression: Array(9).fill('gzip') })
      .success,
    false
  )
  assert.equal(
    handshakeClientPayloadSchema.safeParse({ ...legacy, compression: ['x'.repeat(33)] }).success,
    false
  )
})

test('pairing payload rejects malformed keys, non-websocket endpoints, and empty endpoint lists', () => {
  assert.throws(() => pairingPayloadSchema.parse(pairingPayload({ desktopKey: 'short' })))
  assert.throws(() => pairingPayloadSchema.parse(pairingPayload({ token: `${KEY}=` })))
  assert.throws(() =>
    pairingPayloadSchema.parse(
      pairingPayload({ endpoints: [{ kind: 'tunnel', url: 'https://example.com/remote/v1' }] })
    )
  )
  assert.throws(() => pairingPayloadSchema.parse(pairingPayload({ endpoints: [] })))
  assert.throws(() => pairingPayloadSchema.parse({ ...pairingPayload(), v: 2 }))
})

test('decodePairingUrl rejects foreign schemes, other versions, and tampered payloads', () => {
  const url = encodePairingUrl(pairingPayload())

  assert.throws(() => decodePairingUrl(url.replace('yachiyo-remote://', 'https://')))
  assert.throws(() => decodePairingUrl(url.replace('v=1', 'v=2')))
  assert.throws(() => decodePairingUrl(`${url.slice(0, -4)}AAAA`))
})

test('projections, events, pushes, and mailbox content survive a JSON round trip', () => {
  roundTrip(remoteThreadDetailSchema, {
    thread: summary,
    messages: [message],
    hasMoreBefore: false,
    toolCalls: [
      {
        id: 'tool-1',
        runId: 'run-1',
        toolName: 'askUser',
        status: 'waiting-for-user',
        title: 'Ask user',
        truncated: false,
        question: { question: 'Which branch?', choices: ['main', 'dev'] },
        startedAt: '2026-09-22T11:59:30.000Z'
      }
    ],
    queuedFollowUps: [],
    activeRunId: 'run-1',
    pendingPlan: false,
    todoItems: [{ id: 'todo-1', content: 'Check CI', status: 'in_progress' }]
  })

  roundTrip(remoteEventSchema, { type: 'thread.summary', threadId: 'thread-1', summary })
  roundTrip(remoteEventSchema, {
    type: 'message.completed',
    threadId: 'thread-1',
    runId: 'run-1',
    message
  })
  roundTrip(remotePushSchema, {
    type: 'event',
    epoch: 'epoch-1',
    seq: 7,
    timestamp: '2026-09-22T12:00:00.000Z',
    event: {
      type: 'message.delta',
      threadId: 'thread-1',
      runId: 'run-1',
      messageId: 'message-1',
      delta: 'Hel'
    }
  })
  roundTrip(remotePushSchema, { type: 'resync', epoch: 'epoch-2', seq: 0, reason: 'epoch-changed' })
  roundTrip(mailboxPlaintextSchema, {
    remoteDeviceId: '0123456789abcdef0123456789abcdef',
    endpoints: [{ kind: 'tunnel', url: 'wss://new-host.trycloudflare.com/remote/v1' }],
    counter: 3,
    issuedAt: '2026-09-22T12:00:00.000Z'
  })
})

test('method inputs reject values outside the facade contract', () => {
  const send = remoteMethods['chat.send'].input
  assert.equal(send.safeParse({ threadId: 't', content: 'hi' }).success, true)
  assert.equal(send.safeParse({ threadId: '', content: 'hi' }).success, false)
  assert.equal(send.safeParse({ threadId: 't', content: 'hi', mode: 'force' }).success, false)
  assert.equal(
    send.safeParse({ threadId: 't', content: 'hi', attachmentIds: Array(15).fill('a') }).success,
    false
  )

  const begin = remoteMethods['attachments.begin'].input
  assert.equal(
    begin.safeParse({ filename: 'a.png', mediaType: 'image/png', size: 25 * 1024 * 1024 + 1 })
      .success,
    false
  )

  const chunk = remoteMethods['attachments.chunk'].input
  assert.equal(chunk.safeParse({ uploadId: 'u', index: 0, data: 'not base64!' }).success, false)

  const subscribe = remoteMethods['events.subscribe'].input
  assert.equal(subscribe.safeParse({ threadIds: Array(33).fill('t') }).success, false)
  assert.equal(
    subscribe.safeParse({ threadIds: [], resumeFrom: { epoch: 'e', seq: -1 } }).success,
    false
  )

  const hello = remoteMethods['remote.hello'].input
  assert.equal(
    hello.safeParse({ protocolVersion: 2, client: { app: 'ios', version: '1' } }).success,
    false
  )
})

test('generated JSON Schema lists every facade method and matches the committed file', () => {
  const document = buildRemoteProtocolJsonSchema()
  const methods = document['x-methods'] as Record<string, { input: string; output: string }>
  const defs = document.$defs as Record<string, unknown>

  assert.deepEqual(Object.keys(methods).sort(), [...REMOTE_METHOD_NAMES].sort())
  for (const { input, output } of Object.values(methods)) {
    assert.ok(defs[input], `missing $defs entry ${input}`)
    assert.ok(defs[output], `missing $defs entry ${output}`)
  }

  const committed = readFileSync(
    new URL('./generated/remote-protocol.schema.json', import.meta.url),
    'utf8'
  )
  // Compared as parsed JSON: Windows checkouts may rewrite line endings.
  assert.deepEqual(JSON.parse(committed), document)
})
