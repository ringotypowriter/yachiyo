import assert from 'node:assert/strict'
import test from 'node:test'
import { createComposerPredictionService } from './composerPrediction.ts'
import { createInMemoryYachiyoStorage } from '../../storage/memoryStorage.ts'
import type {
  AuxiliaryGenerationService,
  AuxiliaryTextGenerationRequest
} from '../../runtime/models/auxiliaryGeneration.ts'
import type { MessageRecord } from '@yachiyo/shared/protocol'

const settings = {
  providerName: 'test',
  provider: 'openai' as const,
  model: 'test',
  apiKey: 'key',
  baseUrl: ''
}
const message = (
  id: string,
  role: MessageRecord['role'],
  content: string,
  parentMessageId?: string
): MessageRecord => ({
  id,
  threadId: 'thread',
  parentMessageId,
  role,
  content,
  status: 'completed',
  createdAt: `2026-10-11T00:00:0${id.length}Z`
})
function fixture(
  generateText: AuxiliaryGenerationService['generateText'],
  messages: MessageRecord[] = [
    message('user', 'user', 'Review the module'),
    message('reply', 'assistant', 'Review complete. The parser lacks a regression test.', 'user')
  ],
  headMessageId = 'reply'
): {
  service: ReturnType<typeof createComposerPredictionService>
  storage: ReturnType<typeof createInMemoryYachiyoStorage>
  setRunning: (value: boolean) => void
} {
  const storage = createInMemoryYachiyoStorage()
  storage.createThread({
    thread: { id: 'thread', title: 'Review', updatedAt: '2026-10-11T00:00:00Z', headMessageId },
    createdAt: '2026-10-11T00:00:00Z',
    messages
  })
  let running = false
  const service = createComposerPredictionService({
    auxiliary: { generateText },
    storage,
    isThreadRunning: () => running
  })
  return {
    service,
    storage,
    setRunning: (value: boolean): void => {
      running = value
    }
  }
}
const request = { sessionId: 'one', threadId: 'thread' }

test('predicts a complete next instruction from only the selected visible conversation', async () => {
  let captured: AuxiliaryTextGenerationRequest | undefined
  const { service } = fixture(
    async (input) => {
      captured = input
      return { status: 'success', settings, text: ' Add the missing regression test. ' }
    },
    [
      message('user', 'user', 'Review the module'),
      {
        ...message('hidden', 'assistant', 'Private background notification', 'user'),
        hidden: true
      },
      message('reply', 'assistant', 'The parser lacks a regression test.', 'hidden'),
      message('other', 'assistant', 'Unselected alternative', 'user')
    ]
  )
  assert.equal(await service.predict(request), 'Add the missing regression test.')
  assert.equal(captured?.purpose, 'composer-prediction')
  assert.equal(captured?.tools, undefined)
  const transcript = JSON.parse(String(captured?.messages.at(-1)?.content))
  assert.deepEqual(transcript, [
    { role: 'user', content: 'Review the module' },
    { role: 'assistant', content: 'The parser lacks a regression test.' }
  ])
})

test('does not invent instructions for a new chat, missing context, or unfinished reply', async () => {
  let calls = 0
  const generateText: AuxiliaryGenerationService['generateText'] = async () => {
    calls++
    return { status: 'success', settings, text: 'Next' }
  }
  const normal = fixture(generateText)
  assert.equal(await normal.service.predict({ sessionId: 'one' }), '')
  assert.equal(await normal.service.predict({ ...request, threadId: 'missing' }), '')
  normal.setRunning(true)
  assert.equal(await normal.service.predict(request), '')
  const unfinished = fixture(generateText, [
    message('user', 'user', 'Review'),
    { ...message('reply', 'assistant', 'Partial', 'user'), status: 'streaming' }
  ])
  assert.equal(await unfinished.service.predict(request), '')
  const empty = fixture(generateText, [])
  assert.equal(await empty.service.predict(request), '')
  assert.equal(calls, 0)
})

test('cancels pending prediction when its thread is omitted', async () => {
  let signal: AbortSignal | undefined
  let finish!: () => void
  const { service } = fixture(async (input) => {
    signal = input.signal
    await new Promise<void>((resolve) => {
      finish = resolve
    })
    return { status: 'success', settings, text: 'Stale' }
  })
  const pending = service.predict(request)
  assert.equal(await service.predict({ sessionId: 'one' }), '')
  assert.equal(signal?.aborted, true)
  finish()
  assert.equal(await pending, '')
})

test('isolates composer sessions, times out slow calls, and disposes pending work', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const signals: AbortSignal[] = []
  const finishes: (() => void)[] = []
  const { service } = fixture(async (input) => {
    signals.push(input.signal!)
    await new Promise<void>((resolve) => {
      finishes.push(resolve)
    })
    return { status: 'success', settings, text: 'Next' }
  })
  const first = service.predict(request)
  const other = service.predict({ ...request, sessionId: 'two' })
  const latest = service.predict(request)
  assert.equal(signals[0].aborted, true)
  assert.equal(signals[1].aborted, false)
  t.mock.timers.tick(5000)
  assert.equal(signals[1].aborted, true)
  assert.equal(signals[2].aborted, true)
  finishes.forEach((finish) => finish())
  assert.deepEqual(await Promise.all([first, other, latest]), ['', '', ''])
  const closing = service.predict(request)
  service.dispose()
  assert.equal(signals[3].aborted, true)
  finishes[3]()
  assert.equal(await closing, '')
})

test('only reads a bounded selected path and excludes provider replay data', async () => {
  let captured: AuxiliaryTextGenerationRequest | undefined
  const messages = Array.from({ length: 10 }, (_, i) => ({
    ...message(
      `m${i}`,
      i % 2 ? 'assistant' : 'user',
      'x'.repeat(5000),
      i ? `m${i - 1}` : undefined
    ),
    responseMessages: ['provider-private']
  }))
  const { service } = fixture(
    async (input) => {
      captured = input
      return { status: 'success', settings, text: 'Next instruction\nExtra' }
    },
    messages,
    'm9'
  )
  assert.equal(await service.predict(request), 'Next instruction')
  const transcript = JSON.parse(String(captured?.messages.at(-1)?.content))
  assert.equal(transcript.length, 6)
  assert.ok(transcript.every((entry: { content: string }) => entry.content.length <= 2000))
  assert.equal(JSON.stringify(transcript).includes('provider-private'), false)
})

test('quietly omits predictions when the tool model is unavailable or failed', async () => {
  assert.equal(
    await fixture(async () => ({
      status: 'unavailable',
      reason: 'not-configured'
    })).service.predict(request),
    ''
  )
  assert.equal(
    await fixture(async () => ({ status: 'failed', settings, error: 'offline' })).service.predict(
      request
    ),
    ''
  )
})

test('drops a prediction if the conversation changed while the tool model was working', async () => {
  let finish!: () => void
  const { service, storage } = fixture(async () => {
    await new Promise<void>((resolve) => {
      finish = resolve
    })
    return { status: 'success', settings, text: 'Old next step' }
  })
  const pending = service.predict(request)
  storage.updateThread({ ...storage.getThread('thread')!, updatedAt: '2026-10-11T00:01:00Z' })
  finish()
  assert.equal(await pending, '')
})
