import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

import type {
  ToolCallRecord,
  ToolCallUpdatedEvent,
  YachiyoServerEvent
} from '@yachiyo/shared/protocol'
import {
  createDmAskUserStore,
  formatAskUserQuestion,
  resolveAskUserAnswer,
  watchDmAskUserQuestions,
  DM_ASK_USER_TIMEOUT_ANSWER,
  DM_ASK_USER_TIMEOUT_NOTICE,
  DM_ASK_USER_SUPERSEDED_ANSWER,
  type DmAskUserPending
} from './dmAskUser.ts'

function askUserToolCall(overrides: Partial<ToolCallRecord> = {}): ToolCallRecord {
  return {
    id: 'tc-1',
    runId: 'run-1',
    threadId: 'thread-ask',
    toolName: 'askUser',
    status: 'waiting-for-user',
    inputSummary: 'Pick one',
    startedAt: '2026-06-20T00:00:00.000Z',
    details: { kind: 'askUser', question: 'Pick one', choices: ['Alpha', 'Beta'] },
    ...overrides
  }
}

function toolUpdated(toolCall: ToolCallRecord): ToolCallUpdatedEvent {
  return {
    type: 'tool.updated',
    eventId: 'evt-1',
    timestamp: '2026-06-20T00:00:00.000Z',
    threadId: toolCall.threadId,
    runId: toolCall.runId,
    toolCall
  }
}

function createEmitter(): {
  subscribe: (listener: (event: YachiyoServerEvent) => void) => () => void
  emit: (event: YachiyoServerEvent) => void
  size: () => number
} {
  const listeners = new Set<(event: YachiyoServerEvent) => void>()
  return {
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    emit: (event) => {
      for (const listener of [...listeners]) listener(event)
    },
    size: () => listeners.size
  }
}

describe('formatAskUserQuestion', () => {
  it('returns the bare question when there are no choices', () => {
    assert.equal(formatAskUserQuestion('What next?'), 'What next?')
    assert.equal(formatAskUserQuestion('What next?', []), 'What next?')
  })

  it('renders a numbered list with an answer hint when choices exist', () => {
    const text = formatAskUserQuestion('Pick one', ['Alpha', 'Beta'])
    assert.equal(
      text,
      ['Pick one', '', '1. Alpha', '2. Beta', '', 'Reply with a number, or type your answer.'].join(
        '\n'
      )
    )
  })
})

describe('resolveAskUserAnswer', () => {
  const pending = (choices?: string[]): DmAskUserPending => ({
    threadId: 't',
    runId: 'r',
    toolCallId: 'tc',
    ...(choices ? { choices } : {})
  })

  it('maps a bare number to the matching choice', () => {
    assert.equal(resolveAskUserAnswer(pending(['Alpha', 'Beta']), '2'), 'Beta')
    assert.equal(resolveAskUserAnswer(pending(['Alpha', 'Beta']), ' 1 '), 'Alpha')
  })

  it('passes through free-form text and out-of-range numbers verbatim', () => {
    assert.equal(
      resolveAskUserAnswer(pending(['Alpha', 'Beta']), 'something else'),
      'something else'
    )
    assert.equal(resolveAskUserAnswer(pending(['Alpha', 'Beta']), '5'), '5')
    assert.equal(resolveAskUserAnswer(pending(['Alpha', 'Beta']), '0'), '0')
    assert.equal(resolveAskUserAnswer(pending(), '2'), '2')
  })
})

describe('createDmAskUserStore', () => {
  it('stores, reads, and deletes pending entries', () => {
    const store = createDmAskUserStore()
    assert.equal(store.get('u1'), null)
    store.set('u1', { threadId: 't', runId: 'r', toolCallId: 'tc', choices: ['A'] })
    assert.deepEqual(store.get('u1'), {
      threadId: 't',
      runId: 'r',
      toolCallId: 'tc',
      choices: ['A']
    })
    store.delete('u1')
    assert.equal(store.get('u1'), null)
  })

  it('fires onExpire and clears the entry after the TTL', async () => {
    const store = createDmAskUserStore({ ttlMs: 10 })
    let expired = false
    store.set('u1', { threadId: 't', runId: 'r', toolCallId: 'tc' }, () => {
      expired = true
    })
    await delay(30)
    assert.equal(expired, true)
    assert.equal(store.get('u1'), null)
  })

  it('does not fire onExpire if deleted before the TTL', async () => {
    const store = createDmAskUserStore({ ttlMs: 30 })
    let expired = false
    store.set('u1', { threadId: 't', runId: 'r', toolCallId: 'tc' }, () => {
      expired = true
    })
    store.delete('u1')
    await delay(50)
    assert.equal(expired, false)
  })

  it('clear() drops every entry and its timer', async () => {
    const store = createDmAskUserStore({ ttlMs: 10 })
    let expiredA = false
    let expiredB = false
    store.set('a', { threadId: 't', runId: 'r', toolCallId: 'tca' }, () => {
      expiredA = true
    })
    store.set('b', { threadId: 't', runId: 'r', toolCallId: 'tcb' }, () => {
      expiredB = true
    })
    store.clear()
    assert.equal(store.get('a'), null)
    assert.equal(store.get('b'), null)
    await delay(30)
    assert.equal(expiredA, false)
    assert.equal(expiredB, false)
  })
})

describe('watchDmAskUserQuestions', () => {
  function setup(storeTtlMs?: number): {
    emitter: ReturnType<typeof createEmitter>
    store: ReturnType<typeof createDmAskUserStore>
    questions: string[]
    answers: Array<{ runId: string; toolCallId: string; answer: string }>
    notices: string[]
    stop: () => void
  } {
    const emitter = createEmitter()
    const store = createDmAskUserStore(storeTtlMs ? { ttlMs: storeTtlMs } : {})
    const questions: string[] = []
    const answers: Array<{ runId: string; toolCallId: string; answer: string }> = []
    const notices: string[] = []
    const stop = watchDmAskUserQuestions({
      subscribe: emitter.subscribe,
      store,
      channelUserId: 'u1',
      threadId: 'thread-ask',
      runId: 'run-1',
      sendQuestion: async (text) => {
        questions.push(text)
      },
      answerToolQuestion: (input) => {
        answers.push(input)
      },
      sendTimeoutNotice: async (text) => {
        notices.push(text)
      }
    })
    return { emitter, store, questions, answers, notices, stop }
  }

  it('delivers a matching askUser question and parks it in the store', async () => {
    const { emitter, store, questions, stop } = setup()
    emitter.emit(toolUpdated(askUserToolCall()))
    await delay(0)
    assert.equal(questions.length, 1)
    assert.ok(questions[0].includes('Pick one') && questions[0].includes('1. Alpha'))
    assert.deepEqual(store.get('u1'), {
      threadId: 'thread-ask',
      runId: 'run-1',
      toolCallId: 'tc-1',
      choices: ['Alpha', 'Beta']
    })
    store.delete('u1') // clear the parked TTL timer so the test runner can exit
    stop()
  })

  it('delivers each toolCallId at most once', async () => {
    const { emitter, store, questions, stop } = setup()
    const call = askUserToolCall()
    emitter.emit(toolUpdated(call))
    emitter.emit(toolUpdated(call))
    await delay(0)
    assert.equal(questions.length, 1)
    store.delete('u1')
    stop()
  })

  it('ignores non-matching events', async () => {
    const { emitter, questions, store, stop } = setup()
    emitter.emit(toolUpdated(askUserToolCall({ runId: 'other-run' })))
    emitter.emit(toolUpdated(askUserToolCall({ threadId: 'other-thread' })))
    emitter.emit(toolUpdated(askUserToolCall({ status: 'running' })))
    emitter.emit(
      toolUpdated(askUserToolCall({ toolName: 'read', details: { kind: 'read' } as never }))
    )
    await delay(0)
    assert.equal(questions.length, 0)
    assert.equal(store.get('u1'), null)
    stop()
  })

  it('answers with the timeout sentinel and notifies when the TTL expires', async () => {
    const { emitter, answers, notices, store, stop } = setup(10)
    emitter.emit(toolUpdated(askUserToolCall()))
    await delay(40)
    assert.deepEqual(answers, [
      { runId: 'run-1', toolCallId: 'tc-1', answer: DM_ASK_USER_TIMEOUT_ANSWER }
    ])
    assert.deepEqual(notices, [DM_ASK_USER_TIMEOUT_NOTICE])
    assert.equal(store.get('u1'), null)
    stop()
  })

  it('resolves an earlier pending question when a newer one supersedes it', async () => {
    const { emitter, store, answers, questions, stop } = setup()
    emitter.emit(
      toolUpdated(askUserToolCall({ id: 'tc-1', details: { kind: 'askUser', question: 'Q1' } }))
    )
    emitter.emit(
      toolUpdated(askUserToolCall({ id: 'tc-2', details: { kind: 'askUser', question: 'Q2' } }))
    )
    await delay(0)
    assert.deepEqual(answers, [
      { runId: 'run-1', toolCallId: 'tc-1', answer: DM_ASK_USER_SUPERSEDED_ANSWER }
    ])
    assert.equal(store.get('u1')?.toolCallId, 'tc-2')
    assert.equal(questions.length, 2)
    store.delete('u1')
    stop()
  })

  it('stops delivering after unsubscribe', async () => {
    const { emitter, questions, stop } = setup()
    stop()
    emitter.emit(toolUpdated(askUserToolCall()))
    await delay(0)
    assert.equal(questions.length, 0)
    assert.equal(emitter.size(), 0)
  })
})
