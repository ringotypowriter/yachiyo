import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { RemoteEvent, RemotePush } from '@yachiyo/shared/remote/events'
import type { RemoteChatAccepted } from '@yachiyo/shared/remote/methods'
import type { RemoteThreadDetail, RemoteThreadSummary } from '@yachiyo/shared/remote/projections'
import { createFakeDesktopServer } from '@yachiyo/runtime/app/host/remote/testing/createFakeDesktopServer'

import { createAttachmentStaging } from './attachmentStaging.ts'
import { createInProcessRemotePorts } from './inProcessPorts.ts'
import { createRemoteFacade, type RemoteCallContext } from './remoteFacade.ts'
import { RemoteEventHub } from './remoteEventHub.ts'

// 1x1 transparent PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
)

interface Harness {
  call: <T = unknown>(method: string, input?: unknown) => Promise<T>
  events: RemotePush[]
  audit: string[]
  waitForEvent: (predicate: (event: RemoteEvent) => boolean) => Promise<RemoteEvent>
}

async function withFacade(fn: (harness: Harness) => Promise<void>): Promise<void> {
  const fake = await createFakeDesktopServer({
    chunkDelayMs: 0,
    configToml: [
      '[[essentials]]',
      'id = "essential-1"',
      'icon = "🧪"',
      'iconType = "emoji"',
      'label = "Lab"',
      'order = 0'
    ].join('\n')
  })
  const uploads = await mkdtemp(join(tmpdir(), 'yachiyo-remote-uploads-'))
  const ports = createInProcessRemotePorts(fake.server)
  const hub = new RemoteEventHub({
    subscribe: (listener) => fake.server.subscribe(listener),
    getThreadSummary: (threadId) => ports.host['host.remote.getThreadSummary']({ threadId }),
    coalesceMs: 5
  })
  hub.start()
  const audit: string[] = []
  const facade = createRemoteFacade({
    server: ports.server,
    host: ports.host,
    attachments: createAttachmentStaging({ directory: uploads }),
    identity: () => ({
      remoteDeviceId: '0123456789abcdef0123456789abcdef',
      deviceName: 'Test Mac',
      appVersion: '0.0.0-test'
    }),
    epoch: () => hub.epoch,
    audit: (line) => audit.push(line)
  })

  const events: RemotePush[] = []
  const waiters: Array<{
    predicate: (event: RemoteEvent) => boolean
    resolve: (e: RemoteEvent) => void
  }> = []
  const subscription = hub.attach((push) => {
    events.push(push)
    if (push.type !== 'event') return
    for (const waiter of [...waiters]) {
      if (waiter.predicate(push.event)) {
        waiters.splice(waiters.indexOf(waiter), 1)
        waiter.resolve(push.event)
      }
    }
  })
  const context: RemoteCallContext = { pairingId: 'pairing-1', subscription }

  try {
    await fn({
      call: (method, input) => facade.dispatch(context, method, input) as Promise<never>,
      events,
      audit,
      waitForEvent: (predicate) =>
        new Promise((resolve) => {
          const seen = events.find((push) => push.type === 'event' && predicate(push.event))
          if (seen?.type === 'event') resolve(seen.event)
          else waiters.push({ predicate, resolve })
        })
    })
  } finally {
    hub.stop()
    await fake.dispose()
    await rm(uploads, { recursive: true, force: true })
  }
}

test('facade rejects unknown methods, invalid input, and other protocol versions by name', async () => {
  await withFacade(async ({ call }) => {
    await assert.rejects(call('settings.get'), { name: 'RemoteMethodNotFound' })
    await assert.rejects(call('chat.send', { threadId: 't' }), { name: 'RemoteValidationError' })
    await assert.rejects(
      call('remote.hello', { protocolVersion: 2, client: { app: 'a', version: '1' } }),
      {
        name: 'RemoteProtocolVersionMismatch'
      }
    )
    const hello = await call<{ remoteDeviceId: string; activeRunEnterBehavior: string }>(
      'remote.hello',
      {
        protocolVersion: 1,
        client: { app: 'test', version: '1' }
      }
    )
    assert.equal(hello.remoteDeviceId, '0123456789abcdef0123456789abcdef')
    assert.equal(hello.activeRunEnterBehavior, 'enter-steers')
  })
})

test('a phone can answer askUser and follow the run through the event stream', async () => {
  await withFacade(async ({ call, waitForEvent, audit }) => {
    const { thread } = await call<{ thread: RemoteThreadSummary }>('threads.create', {})
    await call('events.subscribe', { threadIds: [thread.id] })

    const accepted = await call<RemoteChatAccepted>('chat.send', {
      threadId: thread.id,
      content: 'ask: deploy now?'
    })
    assert.equal(accepted.kind, 'run-started')
    assert.equal(accepted.userMessage?.content, 'ask: deploy now?')

    const waiting = await waitForEvent(
      (event) => event.type === 'tool.updated' && event.toolCall.status === 'waiting-for-user'
    )
    assert.ok(waiting.type === 'tool.updated')
    const attention = await waitForEvent(
      (event) => event.type === 'thread.summary' && event.summary.needsAttention
    )
    assert.ok(attention)

    await call('run.answerToolQuestion', {
      threadId: thread.id,
      runId: accepted.runId,
      toolCallId: waiting.toolCall.id,
      answer: 'No'
    })
    await waitForEvent((event) => event.type === 'run.status' && event.status === 'completed')

    const detail = await call<RemoteThreadDetail>('threads.load', { threadId: thread.id })
    assert.match(detail.messages.at(-1)?.content ?? '', /You answered: No/)
    assert.ok(audit.some((line) => line.includes('method=chat.send') && line.includes(thread.id)))
    assert.ok(audit.some((line) => line.includes('method=run.answerToolQuestion')))
    assert.equal(
      audit.some((line) => line.includes('threads.load')),
      false
    )
  })
})

test('uploaded images are attached to the sent message and consumed once', async () => {
  await withFacade(async ({ call, waitForEvent }) => {
    await call('events.subscribe', { threadIds: [] })
    const { thread } = await call<{ thread: RemoteThreadSummary }>('threads.create', {})
    const { uploadId } = await call<{ uploadId: string }>('attachments.begin', {
      filename: 'dot.png',
      mediaType: 'image/png',
      size: PNG.length
    })
    await call('attachments.chunk', { uploadId, index: 0, data: PNG.toString('base64') })
    const committed = await call<{ attachmentId: string; kind: string }>('attachments.commit', {
      uploadId,
      sha256: createHash('sha256').update(PNG).digest('hex')
    })
    assert.equal(committed.kind, 'image')

    const accepted = await call<RemoteChatAccepted>('chat.send', {
      threadId: thread.id,
      content: 'look',
      attachmentIds: [committed.attachmentId]
    })
    assert.deepEqual(
      accepted.userMessage?.images.map((image) => image.mediaType),
      ['image/png']
    )
    await waitForEvent((event) => event.type === 'run.status' && event.status === 'completed')

    const image = await call<{ mediaType: string; data: string }>('images.get', {
      threadId: thread.id,
      messageId: accepted.userMessage!.id,
      imageId: '0'
    })
    assert.equal(image.data, PNG.toString('base64'))

    await assert.rejects(
      call('chat.send', {
        threadId: thread.id,
        content: 'again',
        attachmentIds: [committed.attachmentId]
      }),
      { name: 'RemoteNotFound' }
    )
  })
})

test('uploads with a wrong digest or a sensitive filename are rejected', async () => {
  await withFacade(async ({ call }) => {
    await assert.rejects(
      call('attachments.begin', { filename: 'id_rsa', mediaType: 'text/plain', size: 10 }),
      { name: 'RemoteValidationError' }
    )
    const { uploadId } = await call<{ uploadId: string }>('attachments.begin', {
      filename: 'dot.png',
      mediaType: 'image/png',
      size: PNG.length
    })
    await call('attachments.chunk', { uploadId, index: 0, data: PNG.toString('base64') })
    await assert.rejects(call('attachments.commit', { uploadId, sha256: '0'.repeat(64) }), {
      name: 'RemoteValidationError'
    })
  })
})

test('startThread applies the essential and sends the first message in one call', async () => {
  await withFacade(async ({ call, waitForEvent }) => {
    await call('events.subscribe', { threadIds: [] })
    const started = await call<{ thread: RemoteThreadSummary; accepted: RemoteChatAccepted }>(
      'chat.startThread',
      { essentialId: 'essential-1', content: 'hello from the phone' }
    )
    assert.equal(started.thread.icon, '🧪')
    assert.equal(started.accepted.threadId, started.thread.id)
    await waitForEvent((event) => event.type === 'run.status' && event.status === 'completed')

    const { threads } = await call<{ threads: RemoteThreadSummary[] }>('threads.list', {})
    assert.deepEqual(
      threads.map((thread) => thread.id),
      [started.thread.id]
    )
    await assert.rejects(call('chat.startThread', { essentialId: 'missing', content: 'x' }), {
      name: 'RemoteNotFound'
    })
    const after = await call<{ threads: RemoteThreadSummary[] }>('threads.list', {})
    assert.equal(after.threads.length, 1, 'a failed start leaves no empty thread')
  })
})
