import assert from 'node:assert/strict'
import test from 'node:test'

import type { ChatAccepted, YachiyoServerEvent } from '@yachiyo/shared/protocol'

import type { YachiyoServer } from '../YachiyoServer.ts'
import { createRemoteHostOps } from './remoteHostOps.ts'
import { createFakeDesktopServer } from './testing/createFakeDesktopServer.ts'

const SECRET = 'sk-remote-leak-canary-7f3a'

function waitForEvent(
  server: YachiyoServer,
  predicate: (event: YachiyoServerEvent) => boolean
): Promise<YachiyoServerEvent> {
  return new Promise((resolve) => {
    const unsubscribe = server.subscribe((event) => {
      if (!predicate(event)) return
      unsubscribe()
      resolve(event)
    })
  })
}

async function withFakeDesktop(
  fn: (input: {
    server: YachiyoServer
    ops: ReturnType<typeof createRemoteHostOps>
  }) => Promise<void>
): Promise<void> {
  const fake = await createFakeDesktopServer({
    chunkDelayMs: 0,
    configToml: [
      '[[providers]]',
      'name = "secret-provider"',
      'type = "anthropic"',
      `apiKey = "${SECRET}"`,
      'baseUrl = "https://api.anthropic.com"',
      '',
      '[providers.modelList]',
      'enabled = ["claude-test"]',
      'disabled = []',
      '',
      '[[essentials]]',
      'id = "essential-1"',
      'icon = "🧪"',
      'iconType = "emoji"',
      'label = "Lab"',
      'workspacePath = "/tmp/lab"',
      'order = 0',
      '',
      '[general]',
      'themeId = "gobyou"',
      'themeAppearance = "dark"'
    ].join('\n')
  })
  try {
    await fn({ server: fake.server, ops: createRemoteHostOps(fake.server) })
  } finally {
    await fake.dispose()
  }
}

async function runToCompletion(
  server: YachiyoServer,
  threadId: string,
  content: string
): Promise<ChatAccepted> {
  const completed = waitForEvent(server, (event) => event.type === 'run.completed')
  const accepted = await server.sendChat({ threadId, content })
  await completed
  return accepted
}

test('remote projections never contain provider credentials', async () => {
  await withFakeDesktop(async ({ server, ops }) => {
    const thread = await server.createThread()
    await runToCompletion(server, thread.id, 'hello')

    const results = [
      ops['host.remote.listThreadSummaries']({}),
      ops['host.remote.getThreadSummary']({ threadId: thread.id }),
      ops['host.remote.loadThread']({ threadId: thread.id }),
      ops['host.remote.listRecentWorkspaces'](),
      await ops['host.remote.listSelectableModels'](),
      await ops['host.remote.listEssentials'](),
      await ops['host.remote.getAppearance'](),
      await ops['host.remote.getHostInfo'](),
      await ops['host.remote.listTasks']({ threadId: thread.id }),
      ops['host.remote.search']({ query: 'hello' })
    ]
    const serialized = JSON.stringify(results)

    assert.equal(serialized.includes(SECRET), false)
    assert.equal(serialized.includes('sk-scripted-local'), false)
    assert.equal(serialized.includes('apiKey'), false)
    assert.equal(serialized.includes('baseUrl'), false)
  })
})

test('models, essentials, and appearance are projected from settings', async () => {
  await withFakeDesktop(async ({ ops }) => {
    const { models } = await ops['host.remote.listSelectableModels']()
    assert.deepEqual(models.map((model) => `${model.providerName}/${model.model}`).sort(), [
      'scripted/scripted-model',
      'secret-provider/claude-test'
    ])

    const { essentials } = await ops['host.remote.listEssentials']()
    assert.deepEqual(essentials, [
      {
        id: 'essential-1',
        icon: '🧪',
        label: 'Lab',
        workspacePath: '/tmp/lab',
        workspaceName: 'lab',
        privacyMode: false,
        order: 0
      }
    ])

    assert.deepEqual(await ops['host.remote.getAppearance'](), {
      themeId: 'gobyou',
      themeAppearance: 'dark'
    })
  })
})

test('loadThread returns the current branch path with sibling ids and pages backwards', async () => {
  await withFakeDesktop(async ({ server, ops }) => {
    const thread = await server.createThread()
    await runToCompletion(server, thread.id, 'first')
    await runToCompletion(server, thread.id, 'second')

    const full = ops['host.remote.loadThread']({ threadId: thread.id })
    assert.deepEqual(
      full.messages.map((message) => message.role),
      ['user', 'assistant', 'user', 'assistant']
    )
    assert.equal(full.hasMoreBefore, false)

    const lastAssistant = full.messages.at(-1)!
    const retried = waitForEvent(server, (event) => event.type === 'run.completed')
    await server.retryMessage({ threadId: thread.id, messageId: lastAssistant.id })
    await retried

    const afterRetry = ops['host.remote.loadThread']({ threadId: thread.id })
    const newAssistant = afterRetry.messages.at(-1)!
    assert.notEqual(newAssistant.id, lastAssistant.id)
    assert.deepEqual(newAssistant.siblingIds, [lastAssistant.id, newAssistant.id])

    const page = ops['host.remote.loadThread']({ threadId: thread.id, limit: 2 })
    assert.equal(page.messages.length, 2)
    assert.equal(page.hasMoreBefore, true)
    const previous = ops['host.remote.loadThread']({
      threadId: thread.id,
      limit: 2,
      beforeMessageId: page.messages[0]!.id
    })
    assert.deepEqual(
      previous.messages.map((message) => message.id),
      afterRetry.messages.slice(0, 2).map((message) => message.id)
    )
    assert.equal(previous.hasMoreBefore, false)
  })
})

test('a pending askUser question marks the thread as needing attention until answered', async () => {
  await withFakeDesktop(async ({ server, ops }) => {
    const thread = await server.createThread()
    const waiting = waitForEvent(
      server,
      (event) => event.type === 'tool.updated' && event.toolCall.status === 'waiting-for-user'
    )
    const accepted = await server.sendChat({ threadId: thread.id, content: 'ask: ship it?' })
    await waiting

    const summary = ops['host.remote.getThreadSummary']({ threadId: thread.id })
    assert.equal(summary?.needsAttention, true)
    assert.equal(summary?.latestRun?.status, 'running')
    const detail = ops['host.remote.loadThread']({ threadId: thread.id })
    const question = detail.toolCalls.find((toolCall) => toolCall.status === 'waiting-for-user')
    assert.deepEqual(question?.question, { question: 'ship it?', choices: ['Yes', 'No'] })
    assert.equal(detail.activeRunId, accepted.runId)

    const completed = waitForEvent(server, (event) => event.type === 'run.completed')
    server.answerToolQuestion({ runId: accepted.runId, toolCallId: question!.id, answer: 'Yes' })
    await completed

    const after = ops['host.remote.getThreadSummary']({ threadId: thread.id })
    assert.equal(after?.needsAttention, false)
    assert.equal(after?.latestRun?.status, 'completed')
    assert.match(
      ops['host.remote.loadThread']({ threadId: thread.id }).messages.at(-1)!.content,
      /You answered: Yes/
    )
  })
})

test('archived and unknown threads are not loadable', async () => {
  await withFakeDesktop(async ({ server, ops }) => {
    const thread = await server.createThread()
    await server.archiveThread({ threadId: thread.id })

    assert.equal(ops['host.remote.getThreadSummary']({ threadId: thread.id }), null)
    assert.throws(() => ops['host.remote.loadThread']({ threadId: thread.id }), {
      name: 'RemoteNotFound'
    })
    assert.throws(() => ops['host.remote.loadThread']({ threadId: 'missing' }), {
      name: 'RemoteNotFound'
    })
  })
})
