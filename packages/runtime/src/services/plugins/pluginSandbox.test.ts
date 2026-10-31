import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { PluginSession } from './pluginSession.ts'
import type { PluginContext } from './pluginTypes.ts'

const context: PluginContext = {
  runId: 'sandbox-run',
  threadId: 'sandbox-thread',
  workspacePath: '/workspace',
  runMode: 'auto'
}

async function load(t: TestContext, ...sources: string[]): Promise<PluginSession> {
  const session = await PluginSession.create(
    sources.map((source, index) => ({ name: `sandbox-${index}.js`, revision: 'test', source }))
  )
  t.after(() => session.dispose())
  return session
}

test('plugins cannot access Node, network, timers or host constructors', async (t) => {
  const session = await load(
    t,
    `export default {apiVersion: 1, hooks: {
    beforeInput(event, api) {
      const globals = ['process', 'require', 'Buffer', 'fetch', 'WebSocket', 'setTimeout', 'WebAssembly']
      return {text: JSON.stringify([
        ...globals.map(name => typeof globalThis[name]),
        api.state.read.constructor('return typeof process')(),
        event.constructor.constructor('return typeof process')()
      ])}
    }
  }}`
  )
  const result = await session.dispatch('beforeInput', context, { text: 'hello' })
  assert.deepEqual(JSON.parse(result!.text), Array(9).fill('undefined'))
})

test('static and dynamic imports cannot load host or external modules', async () => {
  for (const source of [
    `import fs from 'node:fs'; export default {apiVersion: 1, hooks: {beforeInput() {}}}`,
    `await import('node:child_process'); export default {apiVersion: 1, hooks: {beforeInput() {}}}`,
    `import 'https://example.com/plugin.js'; export default {apiVersion: 1, hooks: {beforeInput() {}}}`
  ]) {
    await assert.rejects(async () => {
      const session = await PluginSession.create([{ name: 'imports.js', revision: 'test', source }])
      await session.dispose()
    }, /imports are not supported/i)
  }
})

test('plugin globals and built-in prototypes are isolated from other plugins', async (t) => {
  const session = await load(
    t,
    `globalThis.privateValue = 'leaked'; Object.prototype.privateValue = 'leaked'
     export default {apiVersion: 1, hooks: {beforeInput() {}}}`,
    `export default {apiVersion: 1, hooks: {
       beforeInput() {return {text: typeof globalThis.privateValue + ':' + typeof ({}).privateValue}}
     }}`
  )
  assert.deepEqual(await session.dispatch('beforeInput', context, { text: 'input' }), {
    text: 'undefined:undefined'
  })
})

test('top-level await and concurrent state promises retain module state across hooks', async (t) => {
  const session = await load(
    t,
    `
    let calls = await Promise.resolve(0)
    export default {apiVersion: 1, hooks: {
      async beforeInput(event, api) {
        const [a, b] = await Promise.all([api.state.read('run', 'a'), api.state.read('run', 'b')])
        await Promise.all([
          api.state.write('run', 'a', a.version, (a.value ?? 0) + 1),
          api.state.write('run', 'b', b.version, (b.value ?? 0) + 2)
        ])
        return {text: (++calls) + ':' + a.value + ':' + b.value}
      }
    }}
  `
  )
  assert.deepEqual(await session.dispatch('beforeInput', context, { text: '' }), {
    text: '1:null:null'
  })
  assert.deepEqual(await session.dispatch('beforeInput', context, { text: '' }), { text: '2:1:2' })
})

test('a plugin allocation exceeding the VM limit fails without stopping another session', async (t) => {
  const session = await load(
    t,
    `export default {apiVersion: 1, hooks: {
    beforeInput() {return {text: String(new ArrayBuffer(256 * 1024 * 1024).byteLength)}}
  }}`
  )
  await assert.rejects(
    session.dispatch('beforeInput', context, { text: '' }),
    /out of memory|allocation/i
  )
  const healthy = await load(
    t,
    `export default {apiVersion: 1, hooks: {
    beforeInput({text}) {return {text: text.toUpperCase()}}
  }}`
  )
  assert.deepEqual(await healthy.dispatch('beforeInput', context, { text: 'still running' }), {
    text: 'STILL RUNNING'
  })
})

test('state writes reject non-JSON values instead of silently converting them', async (t) => {
  const session = await load(
    t,
    `export default {apiVersion: 1, hooks: {
    async beforeInput(event, api) {
      let rejected = 0
      const values = [NaN, {missing: undefined}, [undefined], {bad: Infinity}]
      for (const [index, value] of values.entries()) {
        try { await api.state.write('run', String(index), 0, value) }
        catch { rejected++ }
      }
      const records = await Promise.all(values.map((_, index) => api.state.read('run', String(index))))
      return {text: JSON.stringify({rejected, versions: records.map(record => record.version)})}
    }
  }}`
  )
  const result = await session.dispatch('beforeInput', context, { text: '' })
  assert.deepEqual(JSON.parse(result!.text), { rejected: 4, versions: [0, 0, 0, 0] })
})

test('a saved state API cannot acquire the next hook context', async (t) => {
  const session = await load(
    t,
    `let saved
    export default {apiVersion: 1, hooks: {
      async beforeInput(event, api) {
        if (!saved) { saved = api; return {text: 'saved'} }
        try { await saved.state.write('run', 'stale', 0, true) }
        catch (error) {
          const current = await api.state.read('run', 'stale')
          return {text: current.version + ':' + error.message}
        }
        throw new Error('Stale state API was accepted')
      }
    }}`
  )
  await session.dispatch('beforeInput', context, { text: '' })
  const result = await session.dispatch(
    'beforeInput',
    { ...context, runId: 'next-run' },
    { text: '' }
  )
  assert.match(result!.text, /^0:State is only available during its active hook/)
})

test('binary subarrays and ArrayBuffers survive hooks without sharing host memory', async (t) => {
  const session = await load(
    t,
    `export default {apiVersion: 1, hooks: {
    beforeModel({messages}) {
      messages[0].content[0].data[0] = 42
      return {messages: [...messages, {role: 'user', content: [
        {type: 'file', data: new Uint8Array([7, 8]), mediaType: 'application/pdf'}
      ]}]}
    }
  }}`
  )
  const original = new Uint8Array([99, 1, 2, 99])
  const buffer = new Uint8Array([3, 4]).buffer
  const result = await session.dispatch('beforeModel', context, {
    stepNumber: 0,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'file', data: original.subarray(1, 3), mediaType: 'application/pdf' },
          { type: 'file', data: buffer, mediaType: 'application/pdf' }
        ]
      }
    ]
  })
  assert.deepEqual(result!.messages, [
    {
      role: 'user',
      content: [
        { type: 'file', data: new Uint8Array([42, 2]), mediaType: 'application/pdf' },
        { type: 'file', data: buffer, mediaType: 'application/pdf' }
      ]
    },
    {
      role: 'user',
      content: [{ type: 'file', data: new Uint8Array([7, 8]), mediaType: 'application/pdf' }]
    }
  ])
  assert.deepEqual([...original], [99, 1, 2, 99])
})

test('a hook cannot flood the state bridge or return an oversized payload', async (t) => {
  const flood = await load(
    t,
    `export default {apiVersion: 1, hooks: {
    async beforeInput(event, api) {
      for (let index = 0; index < 101; index++) await api.state.read('run', 'counter')
    }
  }}`
  )
  await assert.rejects(flood.dispatch('beforeInput', context, { text: '' }), /100 state calls/)
  const large = await load(
    t,
    `export default {apiVersion: 1, hooks: {
    beforeInput() {return {text: 'x'.repeat(9 * 1024 * 1024)}}
  }}`
  )
  await assert.rejects(large.dispatch('beforeInput', context, { text: '' }), /16 MiB|out of memory/)
})

test('initialization and a runaway promise queue remain interruptible', async (t) => {
  await assert.rejects(
    PluginSession.create(
      [
        {
          name: 'initialization.js',
          revision: 'test',
          source: 'while (true) {}'
        }
      ],
      { timeoutMs: 500 }
    ),
    /timed out|interrupted/
  )
  const session = await PluginSession.create(
    [
      {
        name: 'microtasks.js',
        revision: 'test',
        source: `export default {apiVersion: 1, hooks: {
      beforeInput() {
        const again = () => Promise.resolve().then(again)
        return again()
      }
    }}`
      }
    ],
    { timeoutMs: 500 }
  )
  t.after(() => session.dispose())
  await assert.rejects(
    session.dispatch('beforeInput', context, { text: '' }),
    /timed out|interrupted/
  )
})

test('large text retains Unicode, NULs and lone surrogates through hooks and state', async (t) => {
  const session = await load(
    t,
    `export default {apiVersion: 1, hooks: {
    async beforeInput({text}, {state}) {
      const previous = await state.read('run', 'text')
      await state.write('run', 'text', previous.version, text)
      return {text: (await state.read('run', 'text')).value + ':edited'}
    }
  }}`
  )
  for (const text of [
    '项目上下文🙂'.repeat(400),
    'prefix'.repeat(300) + '\0suffix',
    '\ud800' + 'middle'.repeat(300) + '\udc00'
  ]) {
    assert.deepEqual(await session.dispatch('beforeInput', context, { text }), {
      text: text + ':edited'
    })
  }
})

test('text retained by a plugin never resolves against a later invocation or another plugin', async (t) => {
  const session = await load(
    t,
    `let previous
     export default {apiVersion: 1, hooks: {beforeInput({text}) {
       const result = {text: previous === undefined ? text : previous + ':' + text}
       previous = text
       return result
     }}}`,
    `export default {apiVersion: 1, hooks: {beforeInput({text}) {return {text: text + ':second'}}}}`
  )
  const first = 'first'.repeat(400)
  const second = 'second'.repeat(400)
  assert.deepEqual(await session.dispatch('beforeInput', context, { text: first }), {
    text: first + ':second'
  })
  assert.deepEqual(await session.dispatch('beforeInput', context, { text: second }), {
    text: first + ':' + second + ':second'
  })
})

test('repeating unchanged text cannot bypass the result size limit', async (t) => {
  const session = await load(
    t,
    `export default {apiVersion: 1, hooks: {
    beforeModel({messages}) {return {messages: Array(3).fill(messages[0])}}
  }}`
  )
  await assert.rejects(
    session.dispatch('beforeModel', context, {
      stepNumber: 0,
      messages: [{ role: 'user', content: 'x'.repeat(3 * 1024 * 1024) }]
    }),
    /16 MiB|out of memory/
  )
})

test('synchronous hooks and custom thenables apply the same ordered transformations', async (t) => {
  const session = await load(
    t,
    `export default {apiVersion: 1, hooks: {beforeInput({text}) {return {text: text + ':sync'}}}}`,
    `export default {apiVersion: 1, hooks: {beforeInput({text}) {
      return {then(resolve) {Promise.resolve().then(() => resolve({text: text + ':async'}))}}
    }}}`
  )
  assert.deepEqual(await session.dispatch('beforeInput', context, { text: 'input' }), {
    text: 'input:sync:async'
  })
})

test('thenable hooks read the then getter once and preserve its receiver', async (t) => {
  const session = await load(
    t,
    `export default {apiVersion: 1, hooks: {
    beforeInput({text}) {
      let reads = 0
      return {text, get then() {
        if (++reads > 1) throw new Error('then getter was read twice')
        return function(resolve) {resolve({text: this.text + ':' + reads})}
      }}
    }
  }}`
  )
  assert.deepEqual(await session.dispatch('beforeInput', context, { text: 'value' }), {
    text: 'value:1'
  })
})

test('evicting cached text preserves plugin-held values and subsequent input', async (t) => {
  const session = await load(
    t,
    `let saved
    export default {apiVersion: 1, hooks: {beforeInput({text}) {
      saved ??= text
      return {text: text + ':' + saved.slice(-32)}
    }}}`
  )
  const original = 'original'.repeat(128 * 1024)
  for (const text of [
    original,
    'second'.repeat(180 * 1024),
    'third'.repeat(220 * 1024),
    original,
    'large'.repeat(500 * 1024)
  ]) {
    assert.deepEqual(await session.dispatch('beforeInput', context, { text }), {
      text: text + ':' + original.slice(-32)
    })
  }
})

test('retained message objects and edited fields resolve against their own text', async (t) => {
  const session = await load(
    t,
    `let previous
    export default {apiVersion: 1, hooks: {beforeModel({messages}) {
      messages[0].content += ':edited'
      const result = previous ? [previous, ...messages] : messages
      previous = messages[0]
      return {messages: result}
    }}}`
  )
  const first = 'first'.repeat(400)
  const second = 'second'.repeat(400)
  await session.dispatch('beforeModel', context, {
    messages: [{ role: 'user', content: first }],
    stepNumber: 0
  })
  assert.deepEqual(
    await session.dispatch('beforeModel', context, {
      messages: [{ role: 'user', content: second }],
      stepNumber: 1
    }),
    {
      messages: [
        { role: 'user', content: first + ':edited' },
        { role: 'user', content: second + ':edited' }
      ]
    }
  )
})
