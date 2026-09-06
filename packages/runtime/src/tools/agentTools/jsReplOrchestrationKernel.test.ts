import assert from 'node:assert/strict'
import test from 'node:test'
import { createOrchestrationKernel } from './jsReplOrchestrationKernel.ts'

test('orchestration persists bindings and bridges asynchronous JSON tools', async () => {
  const calls: unknown[] = []
  const kernel = await createOrchestrationKernel(['read', 'webRead'], async (name, input) => {
    calls.push({ name, input })
    return name === 'read' ? 'local text' : { text: 'web text' }
  })
  try {
    const first = await kernel.execute(
      'const values = await parallel([() => read("a"), () => tool.webRead({url:"https://example.com"})]); display(values); values.length',
      1000
    )
    assert.equal(first.error, undefined)
    assert.equal(first.result, '2')
    assert.deepEqual(JSON.parse(first.displayOutputs[0]!), ['local text', { text: 'web text' }])
    assert.equal((await kernel.execute('return values[0]', 1000)).result, 'local text')
    assert.equal(calls.length, 2)
  } finally {
    kernel.dispose()
  }
})

test('orchestration exposes no Node capabilities, imports or unlisted tools', async () => {
  let calls = 0
  const kernel = await createOrchestrationKernel(['read'], async () => {
    calls++
    return 'ok'
  })
  try {
    assert.equal(
      (
        await kernel.execute(
          '[typeof process, typeof require, typeof fetch, typeof Buffer, typeof write, Function("return typeof process")(), await tool.read.constructor("return typeof process")()]',
          1000
        )
      ).result,
      '[\n  "undefined",\n  "undefined",\n  "undefined",\n  "undefined",\n  "undefined",\n  "undefined",\n  "undefined"\n]'
    )
    for (const code of [
      'await import("node:fs")',
      'import fs from "node:fs"',
      'await tool.bash({command:"pwd"})',
      'await tool.jsRepl({code:"1"})'
    ]) {
      assert.ok((await kernel.execute(code, 1000)).error)
    }
    assert.equal(calls, 0)
    assert.equal((await kernel.execute('2 + 3', 1000)).result, '5')
  } finally {
    kernel.dispose()
  }
})

test('orchestration drains guest jobs before finishing their owning cell', async () => {
  let calls = 0
  const kernel = await createOrchestrationKernel(['read'], async () => {
    calls++
    return 'ok'
  })
  try {
    await kernel.execute(
      'globalThis.n=0; const spin=()=>{if(++n===150) tool.read({path:"secret"}); else Promise.resolve().then(spin)}; spin(); 42',
      1000
    )
    const firstCalls = calls
    await kernel.execute('99', 1000)
    assert.equal(calls, firstCalls)
  } finally {
    kernel.dispose()
  }
})

test('orchestration interrupts CPU and Promise loops and bounds collected output', async () => {
  const kernel = await createOrchestrationKernel([], async () => undefined)
  try {
    const result = await kernel.execute(
      'for(let i=0;i<10000;i++) console.log("x".repeat(1000)); 42',
      1000
    )
    assert.ok(result.consoleLines.join('').length <= 100_000)
    assert.equal(result.result, '42')
    assert.equal((await kernel.execute('while(true) {}', 30)).timedOut, true)
  } finally {
    kernel.dispose()
  }
  const second = await createOrchestrationKernel([], async () => undefined)
  try {
    assert.equal(
      (
        await second.execute(
          'await new Promise(() => { const spin = () => Promise.resolve().then(spin); spin() })',
          30
        )
      ).timedOut,
      true
    )
  } finally {
    second.dispose()
  }
})
