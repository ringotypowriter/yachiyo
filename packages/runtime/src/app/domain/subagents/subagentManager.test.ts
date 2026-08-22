import assert from 'node:assert/strict'
import test from 'node:test'

import type {
  AgentMessageEnvelope,
  AgentMessageReceipt,
  SendAgentMessageInput,
  YachiyoServerEvent
} from '@yachiyo/shared/protocol'

import {
  SubagentManager,
  type LaunchSubagentInput,
  type SubagentManagerLimits,
  type SubagentRunner,
  type SubagentRunnerFactoryInput,
  type SubagentRunnerTurnInput
} from './subagentManager.ts'

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
}

function deferred<T>(): Deferred<T> {
  return Promise.withResolvers<T>()
}

class FakeRunner implements SubagentRunner {
  readonly turns: SubagentRunnerTurnInput[] = []
  closeCount = 0
  private readonly turnResults: Array<Deferred<{ output: string }>> = []

  runTurn(input: SubagentRunnerTurnInput): Promise<{ output: string }> {
    this.turns.push(input)
    const result = deferred<{ output: string }>()
    this.turnResults.push(result)
    input.signal.addEventListener(
      'abort',
      () => result.reject(input.signal.reason ?? new Error('aborted')),
      { once: true }
    )
    return result.promise
  }

  resolveTurn(output: string): void {
    const result = this.turnResults.shift()
    if (!result) throw new Error('No pending fake turn.')
    result.resolve({ output })
  }

  async close(): Promise<void> {
    this.closeCount += 1
  }
}

interface Harness {
  manager: SubagentManager
  runners: Map<string, FakeRunner>
  deliveries: Array<{
    agentId: string
    kind: 'initial-result' | 'message'
    message: string
    envelope?: AgentMessageEnvelope
  }>
  events: YachiyoServerEvent[]
  advanceTimers: () => void
}

function makeHarness(
  options: {
    idleTtlMs?: number
    limits?: Partial<SubagentManagerLimits>
  } = {}
): Harness {
  let id = 0
  let timerId = 0
  const timerCallbacks = new Map<NodeJS.Timeout, () => void>()
  const runners = new Map<string, FakeRunner>()
  const deliveries: Harness['deliveries'] = []
  const events: YachiyoServerEvent[] = []
  const manager = new SubagentManager({
    createId: () => `id-${++id}`,
    timestamp: () => new Date(1_000 + id).toISOString(),
    emit: (event) => events.push(event),
    runnerFactory: ({ launch }: SubagentRunnerFactoryInput): FakeRunner => {
      const runner = new FakeRunner()
      runners.set(launch.agentId, runner)
      return runner
    },
    deliverToParent: (input) => {
      deliveries.push({
        agentId: input.agentId,
        kind: input.kind,
        message: input.message,
        ...(input.envelope ? { envelope: input.envelope } : {})
      })
    },
    getParentState: () => 'idle',
    setTimer: (callback) => {
      const handle = ++timerId as unknown as NodeJS.Timeout
      timerCallbacks.set(handle, callback)
      return handle
    },
    clearTimer: (handle) => {
      timerCallbacks.delete(handle)
    },
    ...(options.idleTtlMs !== undefined ? { idleTtlMs: options.idleTtlMs } : {}),
    ...(options.limits ? { limits: options.limits } : {})
  })
  return {
    manager,
    runners,
    deliveries,
    events,
    advanceTimers: () => {
      const callbacks = [...timerCallbacks.values()]
      timerCallbacks.clear()
      for (const callback of callbacks) callback()
    }
  }
}

function launchInput(overrides: Partial<LaunchSubagentInput> = {}): LaunchSubagentInput {
  return {
    agentId: 'agent-1',
    parentThreadId: 'thread-1',
    launchRunId: 'run-1',
    agentName: 'general',
    agentType: 'general',
    codeName: 'Akari',
    workspacePath: '/workspace',
    prompt: 'Inspect the workspace.',
    ...overrides
  }
}

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

function sendFromParent(
  manager: SubagentManager,
  threadId: string,
  agentId: string,
  message: string
): AgentMessageReceipt {
  const input: SendAgentMessageInput = { to: agentId, message }
  return manager.send({ from: { kind: 'parent', threadId }, ...input })
}

test('launch returns before the first Worker turn completes and delivers its initial result', async () => {
  const harness = makeHarness()
  const receipt = await harness.manager.launch(launchInput())

  assert.deepEqual(receipt, {
    agentId: 'agent-1',
    codeName: 'Akari',
    state: 'running',
    workspacePath: '/workspace'
  })
  assert.equal(harness.manager.list('thread-1')[0]?.state, 'running')
  assert.equal(harness.deliveries.length, 0)

  harness.runners.get('agent-1')!.resolveTurn('Initial result')
  await flush()

  assert.equal(harness.manager.list('thread-1')[0]?.state, 'idle')
  assert.deepEqual(harness.deliveries, [
    { agentId: 'agent-1', kind: 'initial-result', message: 'Initial result' }
  ])
})

test('mailbox preserves FIFO order and wakes an idle agent with one drain loop', async () => {
  const harness = makeHarness()
  await harness.manager.launch(launchInput())
  const runner = harness.runners.get('agent-1')!
  sendFromParent(harness.manager, 'thread-1', 'agent-1', 'first')
  sendFromParent(harness.manager, 'thread-1', 'agent-1', 'second')
  runner.resolveTurn('Initial result')
  await flush()

  assert.equal(runner.turns.length, 2)
  assert.deepEqual(
    runner.turns[1]?.messages.map((message) => message.message),
    ['first', 'second']
  )
  assert.deepEqual(
    runner.turns[1]?.messages.map((message) => message.sequence),
    [1, 2]
  )

  runner.resolveTurn('Follow-up result')
  await flush()
  assert.equal(harness.manager.list('thread-1')[0]?.state, 'idle')

  sendFromParent(harness.manager, 'thread-1', 'agent-1', 'third')
  await flush()
  assert.equal(runner.turns.length, 3)
  assert.deepEqual(
    runner.turns[2]?.messages.map((message) => message.message),
    ['third']
  )
  runner.resolveTurn('Woken result')
  await flush()
  assert.equal(harness.manager.list('thread-1')[0]?.state, 'idle')
})

test('routing rejects cross-team, self-send, unknown, and terminal recipients', async () => {
  const harness = makeHarness()
  await harness.manager.launch(launchInput())
  await harness.manager.launch(
    launchInput({
      agentId: 'agent-2',
      parentThreadId: 'thread-2',
      launchRunId: 'run-2',
      codeName: 'Ibuki'
    })
  )

  assert.throws(
    () => sendFromParent(harness.manager, 'thread-1', 'agent-2', 'cross-team'),
    /not in the sender's team/
  )
  assert.throws(
    () =>
      harness.manager.send({
        from: { kind: 'agent', agentId: 'agent-1' },
        to: 'agent-1',
        message: 'self'
      }),
    /itself/
  )
  assert.throws(
    () => sendFromParent(harness.manager, 'thread-1', 'missing', 'unknown'),
    /Unknown recipient/
  )

  assert.equal(harness.manager.cancel('agent-1'), true)
  assert.throws(
    () =>
      harness.manager.send({
        from: { kind: 'parent', threadId: 'thread-1' },
        to: 'agent-1',
        message: 'terminal'
      }),
    /Terminal agent/
  )
})

test('idle TTL closes an agent and releases its runner', async () => {
  const harness = makeHarness({ idleTtlMs: 10 })
  await harness.manager.launch(launchInput())
  const runner = harness.runners.get('agent-1')!
  runner.resolveTurn('Done')
  await flush()
  harness.advanceTimers()
  await flush()

  assert.equal(harness.manager.list('thread-1')[0]?.state, 'closed')
  assert.equal(runner.closeCount, 1)
})

test('cancel aborts the Agent controller and settles runner cleanup', async () => {
  const harness = makeHarness()
  await harness.manager.launch(launchInput())
  const runner = harness.runners.get('agent-1')!
  assert.equal(harness.manager.cancel('agent-1'), true)
  await flush()

  assert.equal(harness.manager.list('thread-1')[0]?.state, 'cancelled')
  assert.equal(runner.turns[0]?.signal.aborted, true)
  assert.equal(runner.closeCount, 1)
})

test('mailbox and live-agent limits reject without dropping accepted messages', async () => {
  const harness = makeHarness({
    limits: { maxMailboxEnvelopes: 1, maxLiveAgentsPerThread: 1 }
  })
  await harness.manager.launch(launchInput())
  const receipt = sendFromParent(harness.manager, 'thread-1', 'agent-1', 'first')
  assert.equal(receipt.delivery, 'queued')
  assert.throws(
    () => sendFromParent(harness.manager, 'thread-1', 'agent-1', 'second'),
    /mailbox is full/
  )
  await assert.rejects(
    harness.manager.launch(launchInput({ agentId: 'agent-2', codeName: 'Ibuki' })),
    /maximum of 1 live agents/
  )
  await harness.manager.close()
})

test('close cancels running agents, waits for runner cleanup, and clears live state', async () => {
  const harness = makeHarness()
  await harness.manager.launch(launchInput())
  const runner = harness.runners.get('agent-1')!
  const closePromise = harness.manager.close()
  await flush()
  assert.equal(runner.turns[0]?.signal.aborted, true)
  assert.equal(runner.closeCount, 1)
  await closePromise
  assert.deepEqual(harness.manager.list(), [])
})
test('closeThread cancels and waits for only that thread while preserving other agents', async () => {
  const harness = makeHarness()
  await harness.manager.launch(launchInput({ agentId: 'agent-1' }))
  await harness.manager.launch(launchInput({ agentId: 'agent-2', codeName: 'Ibuki' }))
  await harness.manager.launch(
    launchInput({ agentId: 'agent-3', parentThreadId: 'thread-2', launchRunId: 'run-3' })
  )

  harness.runners.get('agent-2')!.resolveTurn('Idle result')
  await flush()
  await harness.manager.closeThread('thread-1')

  assert.deepEqual(harness.manager.list('thread-1'), [])
  assert.equal(harness.runners.get('agent-1')?.closeCount, 1)
  assert.equal(harness.runners.get('agent-2')?.closeCount, 1)
  assert.equal(harness.manager.list('thread-2')[0]?.state, 'running')
  await harness.manager.close()
})
