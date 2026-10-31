import assert from 'node:assert/strict'
import test from 'node:test'
import { MockLanguageModelV4 } from 'ai/test'
import type { LanguageModelV4StreamPart } from '@ai-sdk/provider'
import { z } from 'zod'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { SettingsConfig } from '@yachiyo/shared/protocol'
import { createAiSdkModelRuntime } from '../../runtime/models/modelRuntime.ts'
import { PluginExecutionError } from '../../runtime/models/runtimeErrors.ts'
import type { ModelUsage } from '../../runtime/models/types.ts'
import { createPluginModelHooks, startPluginRun, finishPluginRun } from './pluginHarness.ts'
import { PluginSession } from './pluginSession.ts'
import { PluginState } from './pluginState.ts'
import { trialPlugins } from './pluginTrial.ts'
import type { PluginRunSnapshot } from './pluginTypes.ts'
import { readPluginDiagnostics } from './pluginDiagnostics.ts'

const context = {
  runId: 'run',
  threadId: 'thread',
  workspacePath: '/tmp',
  runMode: 'auto' as const
}
const settings = {
  providerName: 'test',
  provider: 'openai-responses' as const,
  apiKey: 'secret',
  baseUrl: '',
  model: 'first'
}
const config = {
  providers: [
    {
      name: 'test',
      type: 'openai-responses',
      apiKey: 'secret',
      baseUrl: '',
      modelList: { enabled: ['first', 'second'], disabled: ['disabled'] }
    }
  ]
} as SettingsConfig

function response(step: number): ReadableStream<LanguageModelV4StreamPart> {
  return new ReadableStream({
    start(controller) {
      const parts: LanguageModelV4StreamPart[] = [
        { type: 'stream-start', warnings: [] },
        ...(step === 0
          ? [{ type: 'tool-call' as const, toolCallId: 'call', toolName: 'read', input: '{}' }]
          : [
              { type: 'text-start' as const, id: 'text' },
              { type: 'text-delta' as const, id: 'text', delta: 'Done' },
              { type: 'text-end' as const, id: 'text' }
            ]),
        {
          type: 'finish',
          finishReason: { unified: step === 0 ? 'tool-calls' : 'stop', raw: undefined },
          usage: {
            inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 5, text: 5, reasoning: 0 }
          }
        }
      ]
      for (const part of parts) controller.enqueue(part)
      controller.close()
    }
  })
}

test('plugins route real SDK steps, compact context and transform both streamed text and replay history', async (t) => {
  const session = await PluginSession.create(
    [
      {
        name: 'harness.js',
        revision: 'test',
        source: `
    export default {apiVersion: 1, hooks: {
      beforeModel({messages, stepNumber, availableModels, options, ...event}) {
        if (JSON.stringify(event).includes('secret')) throw new Error('credentials leaked')
        return {messages, model: availableModels[stepNumber], options: {...options, temperature: 0.2, maxOutputTokens: 64}}
      },
      afterStep({stepNumber}) { if (stepNumber === 0) return {compact: true} },
      beforeCompact({messages}) { return {skip: true, messages: [...messages, {role: 'system', content: 'plugin checkpoint'}]} },
      textDelta({text}) { return {text: text.replace('Done', 'Ready')} }
    }}
  `
      }
    ],
    { state: new PluginState({ ephemeral: true }) }
  )
  t.after(() => session.dispose())
  const selectedModels: string[] = []
  let calls = 0
  let executions = 0
  const tools = {
    read: {
      description: 'unchanged',
      inputSchema: z.object({}),
      execute: async () => {
        executions++
        return 'read result'
      }
    }
  }
  const runtime = createAiSdkModelRuntime({
    createOpenAIProvider: (() => ({
      responses: (modelId: string) =>
        new MockLanguageModelV4({
          modelId,
          doStream: async (request) => {
            const step = calls++
            selectedModels.push(modelId)
            assert.equal(request.temperature, 0.2)
            assert.equal(request.maxOutputTokens, 64)
            assert.deepEqual(
              request.tools?.map((tool) => ({
                name: tool.name,
                description: tool.type === 'function' ? tool.description : undefined
              })),
              [{ name: 'read', description: 'unchanged' }]
            )
            if (step === 1)
              assert.ok(
                request.prompt.some(
                  (message) => message.role === 'system' && message.content === 'plugin checkpoint'
                )
              )
            return { stream: response(step) }
          }
        })
    })) as never
  })
  const signal = new AbortController().signal
  let output = ''
  let usage: ModelUsage | undefined
  for await (const delta of runtime.streamReply({
    messages: [{ role: 'user', content: 'read and answer' }],
    settings,
    signal,
    tools,
    ...createPluginModelHooks({ session, context, config, signal, toolCount: 1 }),
    onFinish: (value) => {
      usage = value
    }
  }))
    output += delta
  assert.equal(output, 'Ready')
  assert.deepEqual(selectedModels, ['first', 'second'])
  assert.equal(executions, 1)
  assert.match(JSON.stringify(usage?.responseMessages), /Ready/)
  assert.doesNotMatch(JSON.stringify(usage?.responseMessages), /Done/)
})

test('step hooks can stop the loop but cannot bypass the host step budget', async (t) => {
  for (const stop of [true, false]) {
    const session = await PluginSession.create([
      {
        name: 'stop.js',
        revision: 'test',
        source: `export default {apiVersion: 1, hooks: {afterStep() {return {stop: ${stop}}}}}`
      }
    ])
    t.after(() => session.dispose())
    let calls = 0
    const runtime = createAiSdkModelRuntime({
      createOpenAIProvider: (() => ({
        responses: () =>
          new MockLanguageModelV4({
            doStream: async () => {
              calls++
              return { stream: response(0) }
            }
          })
      })) as never
    })
    const signal = new AbortController().signal
    const tools = { read: { inputSchema: z.object({}), execute: async () => 'done' } }
    for await (const delta of runtime.streamReply({
      messages: [{ role: 'user', content: 'read' }],
      settings,
      signal,
      tools,
      maxToolSteps: stop ? 5 : 1,
      stopWhen: () => false,
      ...createPluginModelHooks({ session, context, config, signal, toolCount: 1 })
    }))
      void delta
    assert.equal(calls, 1)
  }
})

test('trial executes hooks and rejects tool overrides and disabled model choices', async () => {
  const fixture = { events: [{ hook: 'beforeModel', event: { messages: [], stepNumber: 0 } }] }
  for (const body of [
    'return {tools: {newTool: {}}}',
    "return {model: {providerName: 'test', model: 'disabled'}}"
  ]) {
    await assert.rejects(
      trialPlugins(
        [
          {
            name: 'bad.js',
            revision: 'test',
            source: `export default {apiVersion: 1, hooks: {beforeModel() {${body}}}}`
          }
        ],
        fixture,
        config
      ),
      /invalid result|not enabled/
    )
  }
  const report = await trialPlugins(
    [
      {
        name: 'state.js',
        revision: 'test',
        source: `export default {apiVersion: 1, hooks: {async beforeInput({text}, {state}) {
    const record = await state.read('plugin', 'count')
    await state.write('plugin', 'count', record.version, (record.value ?? 0) + 1)
    return {text: text + record.version}
  }}}`
      }
    ],
    {
      events: [
        { hook: 'beforeInput', event: { text: 'call' } },
        { hook: 'beforeInput', event: { text: 'call' } }
      ]
    },
    config
  )
  assert.deepEqual(
    report.events.map((event) => event.result),
    [{ text: 'call0' }, { text: 'call1' }]
  )
})

test('plugin errors cannot trigger provider retries or context-window recovery', async (t) => {
  for (const message of ['fetch failed', 'maximum context length exceeded']) {
    const session = await PluginSession.create([
      {
        name: 'failure.js',
        revision: 'test',
        source: `export default {apiVersion: 1, hooks: {beforeModel() {throw new Error(${JSON.stringify(message)})}}}`
      }
    ])
    t.after(() => session.dispose())
    let sleeps = 0
    let compactions = 0
    const runtime = createAiSdkModelRuntime({
      sleepImpl: async () => {
        sleeps++
      },
      createOpenAIProvider: (() => ({
        responses: () =>
          new MockLanguageModelV4({
            doStream: async () => {
              throw new Error('provider must not run')
            }
          })
      })) as never
    })
    const signal = new AbortController().signal
    await assert.rejects(async () => {
      for await (const part of runtime.streamReply({
        messages: [{ role: 'user', content: 'hello' }],
        settings,
        signal,
        ...createPluginModelHooks({ session, context, config, signal, toolCount: 0 }),
        compactMessages: async (messages) => {
          compactions++
          return messages
        }
      }))
        void part
    }, PluginExecutionError)
    assert.equal(sleeps, 0)
    assert.equal(compactions, 0)
  }
})

test('a live run starts once, keeps run state after worker replacement and records its end', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'yachiyo-plugin-lifecycle-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const snapshot: PluginRunSnapshot = {
    sources: [
      {
        name: 'lifecycle.js',
        revision: 'test',
        source: `export default {apiVersion: 1, hooks: {
    async runStart({maxSteps}, {state}) {
      const old = await state.read('run', 'starts')
      await state.write('run', 'starts', old.version, (old.value ?? 0) + 1)
      return {maxSteps: Math.min(maxSteps, 3)}
    },
    async beforeInput({text}, {state}) { const starts = await state.read('run', 'starts'); return {text: text + starts.value} },
    async runEnd({status}, {state}) { const old = await state.read('thread', 'outcome'); await state.write('thread', 'outcome', old.version, status) }
  }}`
      }
    ]
  }
  t.after(async () => {
    await snapshot.session?.dispose()
  })
  const input = {
    snapshot,
    config,
    context,
    directory,
    maxSteps: 5,
    signal: new AbortController().signal
  }
  const first = await startPluginRun(input)
  assert.ok(first)
  assert.equal(snapshot.maxSteps, 3)
  assert.equal(await startPluginRun(input), first)
  await first.dispose()
  const second = await startPluginRun(input)
  assert.ok(second)
  assert.notEqual(second, first)
  assert.deepEqual(await second.dispatch('beforeInput', context, { text: 'start:' }), {
    text: 'start:1'
  })
  await finishPluginRun(snapshot, 'completed')
  const state = await new PluginState({ directory }).request('lifecycle.js', context, {
    operation: 'read',
    scope: 'thread',
    key: 'outcome'
  })
  assert.equal(state.value, 'completed')
  const [report] = (await readPluginDiagnostics('lifecycle.js', directory)) as Array<{
    hooks: Array<{ hook: string; calls: number }>
  }>
  assert.equal(report.hooks.find((hook) => hook.hook === 'runStart')?.calls, 1)
  assert.equal(report.hooks.find((hook) => hook.hook === 'runEnd')?.calls, 1)
})

test('model routing does not refresh credentials for a provider that was not called', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'yachiyo-plugin-model-auth-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'auth.json')
  const payload = Buffer.from(
    JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })
  ).toString('base64url')
  await writeFile(
    path,
    JSON.stringify({
      tokens: { access_token: `e30.${payload}.test`, refresh_token: 'test-refresh' }
    })
  )
  let refreshes = 0
  t.mock.method(globalThis, 'fetch', async () => {
    refreshes++
    throw new Error('unexpected refresh')
  })
  const failure = Object.assign(new Error('invalid credentials'), { statusCode: 401 })
  const runtime = createAiSdkModelRuntime({
    createOpenAIProvider: (() => ({
      responses: () =>
        new MockLanguageModelV4({
          doStream: async () => {
            throw failure
          }
        })
    })) as never
  })
  await assert.rejects(async () => {
    for await (const part of runtime.streamReply({
      messages: [{ role: 'user', content: 'hello' }],
      settings: { ...settings, provider: 'openai-codex', codexSessionPath: path },
      signal: new AbortController().signal,
      prepareStep: async () => ({ settings })
    }))
      void part
  }, /invalid credentials/)
  assert.equal(refreshes, 0)
})
