import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withThreadCapabilities } from '@yachiyo/shared/protocol'
import { createInMemoryYachiyoStorage } from '../../storage/memoryStorage.ts'
import { createAuxiliaryGenerationService } from '../../runtime/models/auxiliaryGeneration.ts'

import type { ChannelGroupRecord, GroupProbeHeadlessAdapterConfig } from '@yachiyo/shared/protocol'
import type { ProviderSettings } from '@yachiyo/shared/protocol'
import { ChannelMessageTooLongError } from '../shared/sendWithUpdateReceipt.ts'
import {
  runGroupProbeHeadlessAdapter,
  createChannelGroupDiscussionService,
  sendGroupReplyWithRewriteFallback
} from './channelGroupDiscussionService.ts'
import { telegramPolicy } from '../shared/channelPolicy.ts'
import type { YachiyoServer } from '../../app/host/YachiyoServer.ts'
import type { GroupMessageEntry } from '@yachiyo/shared/protocol'

test('buffers before enrichment and defers image models across a live switch to mention', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  let saved: GroupMessageEntry[] = []
  let descriptions = 0
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  const service = createChannelGroupDiscussionService({
    platform: 'telegram',
    logLabel: 'test',
    policy: telegramPolicy,
    groupConfig: { enabled: true },
    sendMessage: async () => {},
    server: {
      listChannelGroups: () => [group],
      getStorage: () => ({
        loadGroupMonitorBuffer: () => undefined,
        saveGroupMonitorBuffer: (snapshot: { buffer: GroupMessageEntry[] }) => {
          saved = snapshot.buffer
        },
        deleteGroupMonitorBuffer: () => {}
      }),
      getChannelsConfig: () => ({ imageToText: { enabled: true } }),
      getImageToTextService: () => ({
        describe: async () => {
          descriptions++
          return { altText: 'cat' }
        }
      })
    } as unknown as YachiyoServer
  })
  t.after(() => service.stop())
  const entry: GroupMessageEntry = {
    senderName: 'Alice',
    senderExternalUserId: '1',
    text: 'reply',
    isMention: false,
    timestamp: Date.now() / 1000
  }
  service.routeMessage(group.id, entry, async () => {
    await pending
    return {
      text: 'quoted context\nreply',
      images: [{ dataUrl: 'data:image/png;base64,AAA', mediaType: 'image/png' }]
    }
  })
  t.mock.timers.tick(5000)
  assert.equal(saved[0], entry)
  assert.equal(entry.enrichmentPending, true)
  service.setPreferences({ mode: 'mention' })
  release()
  await pending
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(entry.enrichmentPending, false)
  assert.equal(entry.text, 'quoted context\nreply')
  assert.equal(entry.imageDescriptionDeferred, true)
  assert.equal(descriptions, 0)
})

const settings: ProviderSettings = {
  providerName: 'Claude Code',
  provider: 'anthropic',
  model: 'sonnet',
  apiKey: '',
  baseUrl: ''
}

const adapter: GroupProbeHeadlessAdapterConfig = {
  adapter: 'claude-code',
  providerName: 'Claude Code',
  model: 'sonnet'
}

const group: ChannelGroupRecord = {
  id: 'group-1',
  platform: 'telegram',
  externalGroupId: 'tg-group-1',
  name: 'Test Group',
  label: 'Test Group',
  status: 'approved',
  workspacePath: '/tmp/group-workspace',
  createdAt: '2026-04-21T00:00:00.000Z'
}

test('headless adapter returns a reply for runtime delivery without sending or fabricating a receipt', async () => {
  const outcome = await runGroupProbeHeadlessAdapter({
    adapter,
    group,
    messages: [{ role: 'user', content: 'ping' }],
    runClaudeCodeProbe: async () => ({
      status: 'success',
      decision: { action: 'send', message: 'hello' },
      auxiliaryResult: { status: 'success', settings, text: 'hello' }
    })
  })
  assert.equal(outcome.reply, 'hello')
  assert.equal(outcome.result.status, 'success')
  assert.equal(outcome.result.usage, undefined)
})

test('headless silence produces no deliverable text', async () => {
  const outcome = await runGroupProbeHeadlessAdapter({
    adapter,
    group,
    messages: [],
    runClaudeCodeProbe: async () => ({
      status: 'success',
      decision: { action: 'silent' },
      auxiliaryResult: { status: 'success', settings, text: '' }
    })
  })
  assert.equal(outcome.reply, null)
})

test('sendGroupReplyWithRewriteFallback sends the original draft when only the rewrite is too long', async () => {
  const attempts: string[] = []

  const sent = await sendGroupReplyWithRewriteFallback({
    original: 'brief original',
    rewritten: 'expanded rewrite',
    send: async (message) => {
      attempts.push(message)
      if (message === 'expanded rewrite') {
        throw new ChannelMessageTooLongError(12, message.length, 12)
      }
    }
  })

  assert.equal(sent, 'brief original')
  assert.deepEqual(attempts, ['expanded rewrite', 'brief original'])
})

test('sendGroupReplyWithRewriteFallback does not retry an ambiguous delivery failure', async () => {
  const attempts: string[] = []

  await assert.rejects(
    sendGroupReplyWithRewriteFallback({
      original: 'brief original',
      rewritten: 'voice rewrite',
      send: async (message) => {
        attempts.push(message)
        throw new Error('network result unknown')
      }
    }),
    /network result unknown/
  )

  assert.deepEqual(attempts, ['voice rewrite'])
})

for (const mode of ['probe', 'mention'] as const) {
  for (const silent of [false, true]) {
    test(
      `${mode} delivers only the final answer through the real auxiliary service (silent=${silent})`,
      { timeout: 5000 },
      async (t) => {
        const home = await mkdtemp(join(tmpdir(), 'group-final-'))
        const oldHome = process.env.YACHIYO_HOME
        process.env.YACHIYO_HOME = home
        t.after(async () => {
          if (oldHome === undefined) delete process.env.YACHIYO_HOME
          else process.env.YACHIYO_HOME = oldHome
          await rm(home, { recursive: true, force: true })
        })
        const storage = createInMemoryYachiyoStorage()
        let complete!: () => void
        const finished = new Promise<void>((resolve) => {
          complete = resolve
        })
        const completeRun = storage.completeRun.bind(storage)
        storage.completeRun = (input) => {
          const result = completeRun(input)
          complete()
          return result
        }
        const thread = withThreadCapabilities({
          id: 'turn-thread',
          title: 'group',
          source: 'telegram' as const,
          channelGroupId: group.id,
          updatedAt: new Date().toISOString()
        })
        storage.createThread({ thread, createdAt: thread.updatedAt })
        const sent: string[] = []
        const apiSettings = { ...settings, providerName: 'test', apiKey: 'test-key' }
        const auxService = createAuxiliaryGenerationService({
          readToolModelSettings: () => apiSettings,
          createModelRuntime: () => ({
            async *streamReply(request) {
              assert.equal(request.tools?.send_group_message, undefined)
              assert.ok(request.tools?.staySilent)
              if (silent)
                await request.tools.staySilent.execute!(
                  {},
                  { toolCallId: 'quiet', messages: request.messages }
                )
              yield 'Checking the documentation.'
              yield 'Here is the answer.'
              request.onFinish?.({
                promptTokens: 10,
                completionTokens: 10,
                totalPromptTokens: 10,
                totalCompletionTokens: 10,
                finishReason: 'stop',
                responseMessages: [
                  {
                    role: 'assistant',
                    content: [
                      { type: 'text', text: 'Checking the documentation.' },
                      { type: 'tool-call', toolCallId: 'search', toolName: 'web_search', input: {} }
                    ]
                  },
                  {
                    role: 'tool',
                    content: [
                      {
                        type: 'tool-result',
                        toolCallId: 'search',
                        toolName: 'web_search',
                        output: { type: 'text', value: 'source' }
                      }
                    ]
                  },
                  {
                    role: 'assistant',
                    content: [
                      { type: 'reasoning', text: 'private reasoning' },
                      { type: 'text', text: 'Here is the answer.' }
                    ]
                  }
                ]
              })
            }
          })
        })
        let id = 0
        const service = createChannelGroupDiscussionService({
          platform: 'telegram',
          logLabel: 'test',
          policy: { ...telegramPolicy, groupHandoffTokenThreshold: 0 },
          groupConfig: { enabled: true, mode },
          sendMessage: async (_group, text) => {
            sent.push(text)
          },
          server: {
            listChannelGroups: () => [{ ...group, workspacePath: home }],
            listChannelUsers: () => [],
            getStorage: () => storage,
            getAuxiliaryGenerationService: () => auxService,
            resolveProviderSettings: () => apiSettings,
            getContextTimeZone: () => 'UTC',
            getWebSearchService: () => ({}),
            findActiveGroupThread: () => thread,
            getThreadTotalTokens: () => 0,
            generateId: () => `id-${id++}`
          } as unknown as YachiyoServer
        })
        t.after(() => service.stop())
        service.routeMessage(group.id, {
          senderName: 'Alice',
          senderExternalUserId: '1',
          text: 'hello',
          isMention: true,
          timestamp: Date.now() / 1000
        })
        await finished
        assert.deepEqual(sent, silent ? [] : ['Here is the answer.'])
        assert.equal(
          storage.listThreadMessages(thread.id).at(-1)?.visibleReply,
          silent ? undefined : 'Here is the answer.'
        )
      }
    )
  }
}
