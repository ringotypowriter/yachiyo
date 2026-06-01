import assert from 'node:assert/strict'
import test from 'node:test'

import type {
  BrowserAutomationSessionRecord,
  MessageRecord as Message,
  ToolCallRecord as ToolCall,
  UseBrowserToolCallDetails
} from '@yachiyo/shared/protocol'
import { deriveBrowserActivity } from './browserActivity.ts'

function browserCall(input: {
  id: string
  session: string
  action: UseBrowserToolCallDetails['action']
  startedAt: string
  status?: ToolCall['status']
  finalUrl?: string
  title?: string
}): ToolCall {
  return {
    id: input.id,
    threadId: 'thread-1',
    toolName: 'useBrowser',
    status: input.status ?? 'completed',
    inputSummary: input.action,
    startedAt: input.startedAt,
    details: {
      kind: 'useBrowser',
      action: input.action,
      session: input.session,
      ...(input.finalUrl ? { finalUrl: input.finalUrl } : {}),
      ...(input.title ? { title: input.title } : {})
    }
  }
}

function assistantMessage(input: {
  id: string
  content: string
  createdAt: string
  status?: Message['status']
}): Message {
  return {
    id: input.id,
    threadId: 'thread-1',
    role: 'assistant',
    content: input.content,
    status: input.status ?? 'completed',
    createdAt: input.createdAt
  }
}

function runtimeSession(input: {
  session: string
  updatedAt: string
  url?: string
  title?: string
}): BrowserAutomationSessionRecord {
  return {
    threadId: 'thread-1',
    session: input.session,
    url: input.url ?? '',
    ...(input.title ? { title: input.title } : {}),
    viewport: { width: 1280, height: 960 },
    updatedAt: input.updatedAt
  }
}

test('deriveBrowserActivity excludes sessions after successful close', () => {
  const activity = deriveBrowserActivity({
    messages: [],

    toolCalls: [
      browserCall({
        id: 'tc-1',
        session: 'main',
        action: 'open',
        startedAt: '2026-05-23T00:00:00.000Z'
      }),
      browserCall({
        id: 'tc-2',
        session: 'main',
        action: 'close',
        startedAt: '2026-05-23T00:00:01.000Z'
      })
    ]
  })

  assert.deepEqual(activity.sessions, [])
  assert.equal(activity.defaultSession, null)
})

test('deriveBrowserActivity does not revive historical browser sessions after restart', () => {
  const activity = deriveBrowserActivity({
    messages: [],
    toolCalls: [
      browserCall({
        id: 'tc-1',
        session: 'default',
        action: 'open',
        startedAt: '2026-05-23T00:00:00.000Z',
        finalUrl: 'https://github.com/trending',
        title: 'Trending repositories on GitHub today · GitHub'
      })
    ]
  })

  assert.deepEqual(activity.sessions, [])
  assert.equal(activity.defaultSession, null)
})

test('deriveBrowserActivity selects the most recently active session by default', () => {
  const activity = deriveBrowserActivity({
    messages: [],
    sessions: [
      runtimeSession({
        session: 'first',
        updatedAt: '2026-05-23T00:00:00.000Z',
        url: 'https://first.example',
        title: 'First'
      }),
      runtimeSession({
        session: 'second',
        updatedAt: '2026-05-23T00:00:01.000Z',
        url: 'https://second.example',
        title: 'Second'
      })
    ],
    toolCalls: [
      browserCall({
        id: 'tc-1',
        session: 'first',
        action: 'open',
        startedAt: '2026-05-23T00:00:00.000Z',
        finalUrl: 'https://first.example',
        title: 'First'
      }),
      browserCall({
        id: 'tc-2',
        session: 'second',
        action: 'open',
        startedAt: '2026-05-23T00:00:01.000Z',
        finalUrl: 'https://second.example',
        title: 'Second'
      })
    ]
  })

  assert.equal(activity.defaultSession, 'second')
  assert.equal(activity.sessions[0]?.session, 'second')
  assert.equal(activity.sessions[1]?.session, 'first')
})

test('deriveBrowserActivity switches latest step to newer assistant text', () => {
  const activity = deriveBrowserActivity({
    messages: [
      assistantMessage({
        id: 'a1',
        content: 'I found the result.',
        createdAt: '2026-05-23T00:00:02.000Z',
        status: 'streaming'
      })
    ],
    toolCalls: [
      browserCall({
        id: 'tc-1',
        session: 'main',
        action: 'click',
        startedAt: '2026-05-23T00:00:01.000Z'
      })
    ]
  })

  assert.equal(activity.latestStep?.kind, 'text')
  assert.equal(
    activity.latestStep?.kind === 'text' ? activity.latestStep.content : '',
    'I found the result.'
  )
})

test('deriveBrowserActivity supports newly added browser actions as latest steps', () => {
  const activity = deriveBrowserActivity({
    messages: [],
    toolCalls: [
      browserCall({
        id: 'tc-1',
        session: 'main',
        action: 'open',
        startedAt: '2026-05-23T00:00:00.000Z'
      }),
      browserCall({
        id: 'tc-2',
        session: 'main',
        action: 'scroll',
        startedAt: '2026-05-23T00:00:01.000Z',
        finalUrl: 'https://example.com#section',
        title: 'Example'
      }),
      browserCall({
        id: 'tc-3',
        session: 'main',
        action: 'goBack',
        startedAt: '2026-05-23T00:00:02.000Z',
        finalUrl: 'https://example.com',
        title: 'Example'
      }),
      browserCall({
        id: 'tc-4',
        session: 'main',
        action: 'goForward',
        startedAt: '2026-05-23T00:00:03.000Z',
        finalUrl: 'https://example.com#section',
        title: 'Example'
      })
    ]
  })

  assert.equal(activity.latestStep?.kind, 'browser')
  assert.equal(
    activity.latestStep?.kind === 'browser' ? activity.latestStep.action : '',
    'goForward'
  )
  assert.equal(
    activity.latestStep?.kind === 'browser' ? activity.latestStep.url : '',
    'https://example.com#section'
  )
})
