import type { RemoteEvent, RemotePush } from '@yachiyo/shared/remote/events'
import type { RemoteChatAccepted } from '@yachiyo/shared/remote/methods'
import type { RemoteThreadDetail, RemoteThreadSummary } from '@yachiyo/shared/remote/projections'

import { RemoteTestClient } from './remoteTestClient.ts'

function isEvent(predicate: (event: RemoteEvent) => boolean): (push: RemotePush) => boolean {
  return (push) => push.type === 'event' && predicate(push.event)
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Remote scenario failed: ${message}`)
}

/**
 * The phone's critical path against a live remote endpoint:
 * pair → hello → list → send → stream → answer askUser → disconnect → resume → forced resync.
 * Used by the CI integration test and by `scripts/remote-test-client.ts` (also over a tunnel).
 */
export async function runRemoteScenario(input: {
  pairingUrl: string
  endpoint?: string
  /** Protocol features to offer; omitted means a phone that predates feature negotiation. */
  features?: readonly string[]
  log?: (line: string) => void
}): Promise<void> {
  const log = input.log ?? (() => undefined)

  const paired = await RemoteTestClient.pair(input.pairingUrl, {
    ...(input.endpoint ? { endpoint: input.endpoint } : {}),
    ...(input.features ? { features: input.features } : {})
  })
  let client = paired.client
  const hello = await client.call<{ epoch: string; deviceName: string }>('remote.hello', {
    protocolVersion: 1,
    client: { app: 'yachiyo-node-test', version: '1.0.0' }
  })
  check(client.grant?.type === 'pairing.granted', 'pairing grant was not delivered')
  log(`paired with ${hello.deviceName}; pairing ${client.grant.pairingId}`)

  const listed = await client.call<{ threads: RemoteThreadSummary[] }>('threads.list', {})
  log(`listed ${listed.threads.length} thread(s)`)

  const cursor = await client.call<{ epoch: string; headSeq: number }>('events.subscribe', {
    threadIds: []
  })
  const { thread, accepted } = await client.call<{
    thread: RemoteThreadSummary
    accepted: RemoteChatAccepted
  }>('chat.startThread', {
    content: 'ask: continue with the migration?'
  })
  await client.call('events.subscribe', {
    threadIds: [thread.id],
    resumeFrom: { epoch: cursor.epoch, seq: cursor.headSeq }
  })
  await client.waitForPush(isEvent((event) => event.type === 'message.delta'))
  const waiting = await client.waitForPush(
    isEvent(
      (event) => event.type === 'tool.updated' && event.toolCall.status === 'waiting-for-user'
    )
  )
  check(waiting.type === 'event' && waiting.event.type === 'tool.updated', 'no askUser question')
  log(`received streamed text and question "${waiting.event.toolCall.question?.question}"`)

  await client.call('run.answerToolQuestion', {
    threadId: thread.id,
    runId: accepted.runId,
    toolCallId: waiting.event.toolCall.id,
    answer: 'Yes'
  })
  await client.waitForPush(
    isEvent(
      (event) =>
        event.type === 'run.status' &&
        event.runId === accepted.runId &&
        event.status === 'completed'
    )
  )
  log('answered the question; run completed')

  const slow = await client.call<RemoteChatAccepted>('chat.send', {
    threadId: thread.id,
    content: 'slow: keep streaming while the phone is away'
  })
  await client.waitForPush(
    isEvent((event) => event.type === 'message.delta' && event.runId === slow.runId)
  )
  const resumeFrom = { epoch: hello.epoch, seq: client.lastSeq() }
  await client.close()
  log(`disconnected at seq ${resumeFrom.seq}`)
  await new Promise((resolve) => setTimeout(resolve, 600))

  client = await RemoteTestClient.connect(paired.endpoint, {
    phoneKeyPair: paired.phoneKeyPair,
    desktopKey: paired.desktopKey,
    ...(input.features ? { features: input.features } : {})
  })
  const resumed = await client.call<{ resumed: boolean; headSeq: number }>('events.subscribe', {
    threadIds: [thread.id],
    resumeFrom
  })
  check(resumed.resumed, 'resume within the buffer was refused')
  // The replay is compacted (merged deltas sit at their last seq), so only its order is fixed.
  const replayed = await client.waitForPush(
    (push) => push.type === 'event' && push.seq > resumeFrom.seq
  )
  check(replayed.type === 'event', 'the missed events were not replayed')
  await client.waitForPush(
    isEvent(
      (event) =>
        event.type === 'run.status' && event.runId === slow.runId && event.status === 'completed'
    )
  )
  log(`resumed from seq ${resumeFrom.seq}; missed events replayed`)

  const stale = await client.call<{ resumed: boolean }>('events.subscribe', {
    threadIds: [thread.id],
    resumeFrom: { epoch: 'stale-epoch', seq: resumeFrom.seq }
  })
  check(!stale.resumed, 'a stale epoch must force a resync')
  const detail = await client.call<RemoteThreadDetail>('threads.load', { threadId: thread.id })
  check(
    detail.messages.some((message) => message.content.includes('chunk39')),
    'reloaded thread is missing the streamed reply'
  )
  log(`forced resync reloaded ${detail.messages.length} message(s)`)
  await client.close()
}
