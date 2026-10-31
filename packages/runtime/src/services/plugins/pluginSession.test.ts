import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { rm } from 'node:fs/promises'
import type { ToolSet } from 'ai'
import { listPluginFiles, readPluginSources } from './pluginFiles.ts'
import { PluginSession } from './pluginSession.ts'
import { applyPluginToolHooks } from './pluginToolHooks.ts'
import type { PluginContext, PluginSource } from './pluginTypes.ts'
import { toRunBoundaryError } from '../../runtime/models/runtimeErrors.ts'

const context: PluginContext = {
  runId: 'run-1',
  threadId: 'thread-1',
  workspacePath: '/workspace',
  runMode: 'auto'
}
const signal = new AbortController().signal

async function directory(t: TestContext): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'yachiyo-plugins-'))
  t.after(() => rm(path, { recursive: true, force: true }))
  return path
}

async function sessionFor(t: TestContext, source: string): Promise<PluginSession> {
  const sources: PluginSource[] = [{ name: 'test.mjs', source, revision: 'test' }]
  const session = await PluginSession.create(sources)
  t.after(() => session.dispose())
  return session
}

test('JS and TS plugins transform each model step in configured order', async (t) => {
  const root = await directory(t)
  await writeFile(
    join(root, 'second.ts'),
    `
    const suffix: string = 'second'
    export default { apiVersion: 1, hooks: {
      beforeModel({messages, stepNumber}) {
        return {messages: [...messages, {role: 'system', content: suffix + ':' + stepNumber}]}
      }
    } }
  `
  )
  await writeFile(
    join(root, 'first.mjs'),
    `
    export default { apiVersion: 1, hooks: {
      beforeModel({messages, context}) {
        return {messages: [...messages, {role: 'system', content: context.workspacePath}]}
      }
    } }
  `
  )
  const session = await PluginSession.create(
    await readPluginSources(['first.mjs', 'second.ts'], root)
  )
  t.after(() => session.dispose())
  const first = await session.beforeModel(context, [{ role: 'user', content: 'Hello' }], 0, signal)
  assert.deepEqual(
    first.map((message) => message.content),
    ['Hello', '/workspace', 'second:0']
  )
  const second = await session.beforeModel(context, [{ role: 'user', content: 'Next' }], 2, signal)
  assert.deepEqual(
    second.map((message) => message.content),
    ['Next', '/workspace', 'second:2']
  )
  assert.deepEqual(await listPluginFiles(root), ['first.mjs', 'second.ts'])
})

test('a captured source survives file edits and fresh runs load the new source', async (t) => {
  const root = await directory(t)
  const source = (text: string): string => `export default {apiVersion: 1, hooks: {
    beforeModel() {return {messages: [{role: 'user', content: '${text}'}]}}
  }}`
  await writeFile(join(root, 'context.js'), source('old'))
  const snapshot = await readPluginSources(['context.js'], root)
  await writeFile(join(root, 'context.js'), source('new'))
  const oldSession = await PluginSession.create(snapshot)
  t.after(() => oldSession.dispose())
  const fresh = await readPluginSources(['context.js'], root)
  const newSession = await PluginSession.create(fresh)
  t.after(() => newSession.dispose())
  assert.deepEqual(await oldSession.beforeModel(context, [], 0, signal), [
    { role: 'user', content: 'old' }
  ])
  assert.deepEqual(await newSession.beforeModel(context, [], 0, signal), [
    { role: 'user', content: 'new' }
  ])
  assert.notEqual(snapshot[0].revision, fresh[0].revision)
})

test('plugins cannot declare tools, unknown hooks, or unsupported API versions', async () => {
  for (const source of [
    `export default { apiVersion: 1, tools: {}, hooks: {beforeModel() {}} }`,
    `export default { apiVersion: 1, hooks: {registerTool() {}} }`,
    `export default { apiVersion: 2, hooks: {beforeModel() {}} }`
  ]) {
    await assert.rejects(
      PluginSession.create([{ name: 'unsupported.js', source, revision: 'test' }]),
      /Unsupported|apiVersion/
    )
  }
})

test('context hooks reject invalid message shapes and tool-set overrides', async (t) => {
  for (const result of [
    `{messages: [{role: 'bogus', content: 'bad'}]}`,
    `{messages: [], tools: {newTool: {}}}`
  ]) {
    const session = await sessionFor(
      t,
      `export default {apiVersion: 1, hooks: {
      beforeModel() {return ${result}}
    }}`
    )
    await assert.rejects(
      session.beforeModel(context, [], 0, signal),
      /test.mjs beforeModel returned invalid/
    )
  }
})

test('blocking a tool prevents its side effect and afterTool can observe successful output', async (t) => {
  const session = await sessionFor(
    t,
    `
    let lastResult
    export default {apiVersion: 1, hooks: {
      beforeTool({input}) {if (input.blocked) return {block: 'blocked by test policy'}},
      afterTool(event) {lastResult = event},
      beforeModel() {return {messages: [{role: 'user', content: JSON.stringify(lastResult)}]}}
    }}
  `
  )
  let executions = 0
  const tools: ToolSet = {
    write: {
      inputSchema: {} as never,
      execute: async () => {
        executions++
        return { saved: 'report.txt' }
      }
    }
  }
  applyPluginToolHooks(tools, () => ({ session, context, signal }))
  const execute = async (blocked: boolean): Promise<unknown[]> => {
    const output: unknown = Reflect.apply(tools.write.execute!, tools.write, [
      { blocked },
      { toolCallId: 'call-1', messages: [] }
    ])
    const items: unknown[] = []
    for await (const item of output as AsyncIterable<unknown>) items.push(item)
    return items
  }
  await assert.rejects(execute(true), /blocked by test policy/)
  assert.equal(executions, 0)
  assert.deepEqual(await execute(false), [{ saved: 'report.txt' }])
  assert.equal(executions, 1)
  const messages = await session.beforeModel(context, [], 1, signal)
  assert.deepEqual(JSON.parse(messages[0].content as string), {
    toolName: 'write',
    toolCallId: 'call-1',
    input: { blocked: false },
    status: 'success',
    output: { saved: 'report.txt' },
    context
  })
  assert.deepEqual(Object.keys(tools), ['write'])
})

test('streaming tools preserve every result and report errors to afterTool', async (t) => {
  const session = await sessionFor(
    t,
    `
    let failure
    export default {apiVersion: 1, hooks: {
      afterTool(event) {failure = event.error},
      beforeModel() {return {messages: [{role: 'user', content: failure}]}}
    }}
  `
  )
  const tools: ToolSet = {
    read: {
      inputSchema: {} as never,
      execute: async function* () {
        yield { partial: 1 }
        yield { partial: 2 }
        throw new Error('read failed')
      }
    }
  }
  applyPluginToolHooks(tools, () => ({ session, context, signal }))
  const items: unknown[] = []
  await assert.rejects(async () => {
    const result: unknown = Reflect.apply(tools.read.execute!, tools.read, [
      {},
      { toolCallId: 'read-1', messages: [] }
    ])
    for await (const value of result as AsyncIterable<unknown>) items.push(value)
  }, /read failed/)
  assert.deepEqual(items, [{ partial: 1 }, { partial: 2 }])
  assert.deepEqual(await session.beforeModel(context, [], 1, signal), [
    { role: 'user', content: 'read failed' }
  ])
})

test('a hook stuck in synchronous code is terminated by its timeout', async (t) => {
  const session = await PluginSession.create(
    [
      {
        name: 'stuck.js',
        revision: 'test',
        source: `export default {apiVersion: 1, hooks: {beforeModel() {while (true) {}}}}`
      }
    ],
    { timeoutMs: 500 }
  )
  t.after(() => session.dispose())
  await assert.rejects(
    session.beforeModel(context, [], 0, signal),
    /stuck.js beforeModel timed out/
  )
})

test('cancellation interrupts a pending hook without waiting for its timeout', async (t) => {
  const session = await sessionFor(
    t,
    `export default {apiVersion: 1, hooks: {
    beforeModel() {return new Promise(() => {})}
  }}`
  )
  const controller = new AbortController()
  const pending = session.beforeModel(context, [], 0, controller.signal)
  const assertion = assert.rejects(pending, /cancelled/)
  await new Promise<void>((resolve) => setImmediate(resolve))
  controller.abort()
  await assertion
})

test('missing enabled files fail visibly and names cannot escape the plugin directory', async (t) => {
  const root = await directory(t)
  await assert.rejects(readPluginSources(['missing.ts'], root), /ENOENT/)
  await assert.rejects(readPluginSources(['../outside.ts'], root), /Invalid plugin filename/)
  assert.deepEqual(await listPluginFiles(join(root, 'absent')), [])
})

test('plugin failures cannot be mistaken for provider retries or context overflow', async (t) => {
  for (const message of ['fetch failed', 'maximum context length exceeded']) {
    const session = await sessionFor(
      t,
      `export default {apiVersion: 1, hooks: {
      beforeModel() {throw new Error(${JSON.stringify(message)})}
    }}`
    )
    await assert.rejects(session.beforeModel(context, [], 0, signal), (error) => {
      assert.equal(toRunBoundaryError(error), error)
      return true
    })
  }
})

test('image URLs and binary attachments survive the worker context round trip', async (t) => {
  const session = await sessionFor(
    t,
    `export default {apiVersion: 1, hooks: {
    beforeModel({messages}) {return {messages}}
  }}`
  )
  const messages = await session.beforeModel(
    context,
    [
      {
        role: 'user',
        content: [
          { type: 'image', image: new URL('https://example.com/image.png') },
          { type: 'file', data: new Uint8Array([1, 2, 3]), mediaType: 'application/pdf' }
        ]
      }
    ],
    0,
    signal
  )
  assert.deepEqual(messages, [
    {
      role: 'user',
      content: [
        { type: 'image', image: 'https://example.com/image.png' },
        { type: 'file', data: new Uint8Array([1, 2, 3]), mediaType: 'application/pdf' }
      ]
    }
  ])
})
