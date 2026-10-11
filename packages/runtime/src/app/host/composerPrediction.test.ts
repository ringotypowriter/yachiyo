import assert from 'node:assert/strict'
import test from 'node:test'
import { createComposerPredictionService } from './composerPrediction.ts'
import type { AuxiliaryTextGenerationRequest } from '../../runtime/models/auxiliaryGeneration.ts'

const settings = {
  providerName: 'test',
  provider: 'openai' as const,
  model: 'test',
  apiKey: 'key',
  baseUrl: ''
}
test('uses auxiliary generation and preserves continuation whitespace', async () => {
  let captured: AuxiliaryTextGenerationRequest | undefined
  const service = createComposerPredictionService({
    generateText: async (request) => {
      captured = request
      return { status: 'success', settings, text: ' a focused test' }
    }
  })
  assert.equal(await service.predict({ sessionId: 'one', text: 'Write' }), ' a focused test')
  assert.equal(captured?.purpose, 'composer-prediction')
  assert.equal(captured?.max_token, 96)
  assert.equal(captured?.tools, undefined)
  assert.equal(captured?.messages.at(-1)?.content, 'Write')
})
test('empty drafts cancel pending requests without invoking a model', async () => {
  let signal: AbortSignal | undefined
  let finish!: () => void
  const service = createComposerPredictionService({
    generateText: async (request) => {
      signal = request.signal
      await new Promise<void>((resolve) => {
        finish = resolve
      })
      return { status: 'success', settings, text: ' stale' }
    }
  })
  const pending = service.predict({ sessionId: 'one', text: 'Write' })
  assert.equal(await service.predict({ sessionId: 'one', text: '' }), '')
  assert.equal(signal?.aborted, true)
  finish()
  assert.equal(await pending, '')
})
test('supersedes only requests from the same composer', async () => {
  const signals: AbortSignal[] = []
  const finishes: (() => void)[] = []
  const service = createComposerPredictionService({
    generateText: async (request) => {
      signals.push(request.signal!)
      await new Promise<void>((resolve) => {
        finishes.push(resolve)
      })
      return { status: 'success', settings, text: ' next' }
    }
  })
  const first = service.predict({ sessionId: 'one', text: 'Write' })
  const other = service.predict({ sessionId: 'two', text: 'Read' })
  const latest = service.predict({ sessionId: 'one', text: 'Write a' })
  assert.equal(signals[0].aborted, true)
  assert.equal(signals[1].aborted, false)
  finishes.forEach((finish) => finish())
  assert.deepEqual(await Promise.all([first, other, latest]), ['', ' next', ' next'])
})
test('unavailable tool model and failed generation quietly produce no suggestion', async () => {
  const unavailable = createComposerPredictionService({
    generateText: async () => ({ status: 'unavailable', reason: 'not-configured' })
  })
  assert.equal(await unavailable.predict({ sessionId: 'one', text: 'Write' }), '')
  const failed = createComposerPredictionService({
    generateText: async () => ({ status: 'failed', error: 'offline', settings })
  })
  assert.equal(await failed.predict({ sessionId: 'one', text: 'Write' }), '')
})

test('bounds drafts and predictions without removing leading spaces', async () => {
  let calls = 0
  const service = createComposerPredictionService({
    generateText: async () => {
      calls++
      return { status: 'success', settings, text: ' next\nUnwanted second line' }
    }
  })
  assert.equal(await service.predict({ sessionId: 'one', text: '   ' }), '')
  assert.equal(await service.predict({ sessionId: 'one', text: 'x'.repeat(12001) }), '')
  assert.equal(calls, 0)
  assert.equal(await service.predict({ sessionId: 'one', text: 'Write' }), ' next')
})

test('times out slow requests and cancels all pending work on shutdown', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const signals: AbortSignal[] = []
  const finishes: (() => void)[] = []
  const service = createComposerPredictionService({
    generateText: async (request) => {
      signals.push(request.signal!)
      await new Promise<void>((resolve) => {
        finishes.push(resolve)
      })
      return { status: 'success', settings, text: ' stale' }
    }
  })
  const slow = service.predict({ sessionId: 'one', text: 'Write' })
  t.mock.timers.tick(5000)
  assert.equal(signals[0].aborted, true)
  finishes[0]()
  assert.equal(await slow, '')
  const closing = service.predict({ sessionId: 'two', text: 'Read' })
  service.dispose()
  assert.equal(signals[1].aborted, true)
  finishes[1]()
  assert.equal(await closing, '')
})
