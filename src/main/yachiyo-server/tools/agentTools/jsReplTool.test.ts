import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { createTool } from './jsReplTool.ts'
import type { AgentToolContext, JsReplToolInput, JsReplToolOutput } from './shared.ts'
import type { JsReplToolCallDetails } from '../../../../shared/yachiyo/protocol.ts'

function makeContext(overrides?: Partial<AgentToolContext>): AgentToolContext {
  return {
    workspacePath: process.cwd(),
    ...overrides
  }
}

interface TrackedJsReplTool {
  execute(input: JsReplToolCallInput): Promise<JsReplToolOutput>
  dispose(): Promise<void>
}

type JsReplToolCallInput = Omit<JsReplToolInput, 'reset' | 'timeout'> &
  Partial<Pick<JsReplToolInput, 'reset' | 'timeout'>>

const createdTools: TrackedJsReplTool[] = []

function createTrackedTool(
  context: AgentToolContext,
  dependencies?: Parameters<typeof createTool>[1]
): TrackedJsReplTool {
  const tool = createTool(context, dependencies) as unknown as TrackedJsReplTool
  createdTools.push(tool)
  return tool
}

async function execute(
  toolInstance: ReturnType<typeof createTrackedTool>,
  input: JsReplToolCallInput
): Promise<{ details: JsReplToolCallDetails; error?: string }> {
  const result = await toolInstance.execute(input)
  return result as { details: JsReplToolCallDetails; error?: string }
}

describe('jsReplTool', () => {
  afterEach(async () => {
    await Promise.all(createdTools.map((t) => t.dispose().catch(() => {})))
    createdTools.length = 0
  })
  it('evaluates basic expressions and returns the result', async () => {
    const tool = createTrackedTool(makeContext())
    const result = await execute(tool, { code: '1 + 2' })
    assert.equal(result.details.result, '3')
    assert.equal(result.error, undefined)
  })

  it('captures console.log output', async () => {
    const tool = createTrackedTool(makeContext())
    const result = await execute(tool, { code: 'console.log("hello"); 42' })
    assert.equal(result.details.consoleOutput, 'hello')
    assert.equal(result.details.result, '42')
  })

  it('captures console.warn and console.error with prefixes', async () => {
    const tool = createTrackedTool(makeContext())
    const result = await execute(tool, {
      code: 'console.warn("caution"); console.error("oops")'
    })
    assert.ok(result.details.consoleOutput?.includes('[warn] caution'))
    assert.ok(result.details.consoleOutput?.includes('[error] oops'))
  })

  it('resets context by default when reset is not specified', async () => {
    const tool = createTrackedTool(makeContext())
    await execute(tool, { code: 'var x = 42', reset: false })
    const result = await execute(tool, { code: 'typeof x' })
    assert.equal(result.details.result, 'undefined')
  })

  it('persists state across calls when reset is false', async () => {
    const tool = createTrackedTool(makeContext())
    await execute(tool, { code: 'var x = 42', reset: false })
    const result = await execute(tool, { code: 'x * 2', reset: false })
    assert.equal(result.details.result, '84')
  })

  it('resets state when reset is true', async () => {
    const tool = createTrackedTool(makeContext())
    await execute(tool, { code: 'var x = 42' })
    const result = await execute(tool, { code: 'typeof x', reset: true })
    assert.equal(result.details.result, 'undefined')
    assert.equal(result.details.contextReset, true)
  })

  it('catches and returns errors', async () => {
    const tool = createTrackedTool(makeContext())
    const result = await execute(tool, { code: 'throw new Error("boom")' })
    assert.ok(result.details.error?.includes('Error: boom'))
    assert.ok(result.error?.includes('Error: boom'))
  })

  it('catches syntax errors', async () => {
    const tool = createTrackedTool(makeContext())
    const result = await execute(tool, { code: 'const =' })
    assert.ok(result.details.error?.includes('SyntaxError'))
  })

  it('catches reference errors', async () => {
    const tool = createTrackedTool(makeContext())
    const result = await execute(tool, { code: 'nonExistentVariable' })
    assert.ok(result.details.error?.includes('ReferenceError'))
  })

  it('returns undefined result without result field when expression is void', async () => {
    const tool = createTrackedTool(makeContext())
    const result = await execute(tool, { code: 'var a = 1' })
    assert.equal(result.details.result, undefined)
  })

  it('serializes objects as JSON', async () => {
    const tool = createTrackedTool(makeContext())
    const result = await execute(tool, { code: '({ a: 1, b: [2, 3] })' })
    const parsed = JSON.parse(result.details.result!)
    assert.deepEqual(parsed, { a: 1, b: [2, 3] })
  })

  it('provides require() for Node built-ins', async () => {
    const tool = createTrackedTool(makeContext())
    const result = await execute(tool, {
      code: 'const path = require("node:path"); path.join("a", "b")'
    })
    assert.ok(result.details.result?.includes('a'))
    assert.ok(result.details.result?.includes('b'))
  })

  it('provides Buffer in the context', async () => {
    const tool = createTrackedTool(makeContext())
    const result = await execute(tool, {
      code: 'Buffer.from("hello").toString("hex")'
    })
    assert.equal(result.details.result, '68656c6c6f')
  })

  it('provides fetch in the context', async () => {
    const tool = createTrackedTool(makeContext())
    const result = await execute(tool, {
      code: 'const r = await fetch("data:text/plain,hello-from-fetch"); return await r.text()'
    })
    assert.equal(result.details.result, 'hello-from-fetch')
    assert.equal(result.error, undefined)
  })

  it('routes fetch through the configured fetch implementation', async () => {
    let captured:
      | {
          url: string
          method: string | undefined
          header: string | null
          body: string
        }
      | undefined

    const tool = createTrackedTool(makeContext(), {
      fetchImpl: async (input, init) => {
        captured = {
          url: input instanceof URL ? input.toString() : String(input),
          method: init?.method,
          header: new Headers(init?.headers).get('x-from-repl'),
          body: await new Response(init?.body).text()
        }
        return new Response('proxied fetch', {
          status: 203,
          headers: { 'x-fetch-path': 'configured' }
        })
      }
    } as Parameters<typeof createTool>[1])

    const result = await execute(tool, {
      code: `
const r = await fetch("data:text/plain,worker-fetch", {
  method: "POST",
  headers: { "x-from-repl": "yes" },
  body: "payload"
})
return JSON.stringify({
  status: r.status,
  text: await r.text(),
  header: r.headers.get("x-fetch-path"),
  url: r.url
})`
    })

    assert.deepEqual(JSON.parse(result.details.result!), {
      status: 203,
      text: 'proxied fetch',
      header: 'configured',
      url: 'data:text/plain,worker-fetch'
    })
    assert.deepEqual(captured, {
      url: 'data:text/plain,worker-fetch',
      method: 'POST',
      header: 'yes',
      body: 'payload'
    })
  })

  it('does not wait for the response body before resolving fetch', async () => {
    const neverEndingBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('partial body'))
      }
    })
    const tool = createTrackedTool(makeContext(), {
      fetchImpl: async () =>
        new Response(neverEndingBody, {
          status: 200,
          headers: { 'x-streaming': 'yes' }
        })
    } as Parameters<typeof createTool>[1])

    const result = await execute(tool, {
      code: `
const r = await fetch("https://example.com/stream")
return JSON.stringify({
  status: r.status,
  header: r.headers.get("x-streaming")
})`,
      timeout: 1
    })

    assert.equal(result.error, undefined)
    assert.deepEqual(JSON.parse(result.details.result!), {
      status: 200,
      header: 'yes'
    })
  })

  it('times out on infinite loops', async () => {
    const tool = createTrackedTool(makeContext())
    const result = await execute(tool, { code: 'while(true) {}', timeout: 1 })
    assert.equal(result.details.timedOut, true)
    assert.ok(result.details.error?.includes('timed out'))
  })

  it('handles multiple console lines', async () => {
    const tool = createTrackedTool(makeContext())
    const result = await execute(tool, {
      code: 'console.log("line1"); console.log("line2"); console.log("line3")'
    })
    const lines = result.details.consoleOutput!.split('\n')
    assert.equal(lines.length, 3)
    assert.equal(lines[0], 'line1')
    assert.equal(lines[1], 'line2')
    assert.equal(lines[2], 'line3')
  })

  it('console output does not leak between calls', async () => {
    const tool = createTrackedTool(makeContext())
    await execute(tool, { code: 'console.log("first call")' })
    const result = await execute(tool, { code: 'console.log("second call")' })
    assert.equal(result.details.consoleOutput, 'second call')
  })

  it('awaits and returns resolved promise results', async () => {
    const tool = createTrackedTool(makeContext())
    const result = await execute(tool, { code: 'await Promise.resolve(42)' })
    assert.equal(result.details.result, '42')
    assert.equal(result.error, undefined)
  })

  it('catches rejected promises', async () => {
    const tool = createTrackedTool(makeContext())
    const result = await execute(tool, { code: 'await Promise.reject(new Error("async boom"))' })
    assert.ok(result.details.error?.includes('async boom'))
  })

  it('clears timers after each execution automatically', async () => {
    const tool = createTrackedTool(makeContext())
    // Schedule timers that would pin the event loop if not cleared
    await execute(tool, { code: 'setInterval(() => {}, 50); setTimeout(() => {}, 60000); "ok"' })
    // If timers leaked, this test's process would hang after completion.
    // The fact that we reach the next call proves they were cleared.
    const result = await execute(tool, { code: '"clean"' })
    assert.equal(result.details.result, 'clean')
  })

  it('allows clearInterval from within REPL code', async () => {
    const tool = createTrackedTool(makeContext())
    const result = await execute(tool, {
      code: 'var id = setInterval(() => {}, 50); clearInterval(id); "cleared"'
    })
    assert.equal(result.details.result, 'cleared')
  })

  it('suppresses setTimeout callback throws instead of leaking as uncaught exceptions', async () => {
    const tool = createTrackedTool(makeContext())
    // Return a promise so the execution stays alive long enough for the 0ms
    // timer to fire before finally{} clears all timers.
    const result = await execute(tool, {
      code:
        'setTimeout(() => { throw new Error("timer boom") }, 0);' +
        'new Promise((r) => setTimeout(r, 10))'
    })
    assert.ok(
      result.details.consoleOutput?.includes('timer boom'),
      `expected console to capture timer error, got: ${result.details.consoleOutput}`
    )
    assert.equal(result.error, undefined)
  })

  it('suppresses setInterval callback throws instead of leaking as uncaught exceptions', async () => {
    const tool = createTrackedTool(makeContext())
    // Keep execution alive until the interval fires at least once.
    const result = await execute(tool, {
      code:
        'var id = setInterval(() => { throw new Error("interval boom") }, 10);' +
        'new Promise((r) => setTimeout(() => { clearInterval(id); r() }, 50))'
    })
    assert.ok(
      result.details.consoleOutput?.includes('interval boom'),
      `expected console to capture interval error, got: ${result.details.consoleOutput}`
    )
    assert.equal(result.error, undefined)
  })

  it('resolves relative fs paths against workspace, not process cwd', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'jsrepl-test-'))
    const originalCwd = process.cwd()
    try {
      const tool = createTrackedTool(makeContext({ workspacePath: tempDir }))
      await execute(tool, {
        code: 'require("node:fs").writeFileSync("test-file.txt", "hello from repl")'
      })
      // File should exist in the workspace, not in process.cwd()
      assert.ok(existsSync(join(tempDir, 'test-file.txt')))
      assert.equal(process.cwd(), originalCwd, 'process cwd must be restored after execution')
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('restores process cwd even if execution throws', async () => {
    const originalCwd = process.cwd()
    const tool = createTrackedTool(makeContext())
    await execute(tool, { code: 'throw new Error("fail")' })
    assert.equal(process.cwd(), originalCwd)
  })

  it('uses cwd override (relative subdir) for fs operations and process.cwd()', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'jsrepl-cwd-'))
    try {
      mkdirSync(join(tempDir, 'sub', 'deep'), { recursive: true })
      const tool = createTrackedTool(makeContext({ workspacePath: tempDir }))
      const result = await execute(tool, {
        code: 'require("node:fs").writeFileSync("out.txt", "x"); process.cwd()',
        cwd: 'sub/deep'
      })
      assert.ok(existsSync(join(tempDir, 'sub', 'deep', 'out.txt')))
      assert.equal(result.details.result, join(tempDir, 'sub', 'deep'))
      assert.equal(result.details.cwd, 'sub/deep')
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('cwd override defaults back to workspace on the next call with no cwd', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'jsrepl-cwd-reset-'))
    try {
      mkdirSync(join(tempDir, 'sub'))
      const tool = createTrackedTool(makeContext({ workspacePath: tempDir }))
      await execute(tool, { code: 'null', cwd: 'sub' })
      const result = await execute(tool, { code: 'process.cwd()' })
      assert.equal(result.details.result, tempDir)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('require("node:process").cwd() returns the per-call cwd', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'jsrepl-node-process-'))
    try {
      mkdirSync(join(tempDir, 'sub'))
      const tool = createTrackedTool(makeContext({ workspacePath: tempDir }))
      const result = await execute(tool, {
        code: 'require("node:process").cwd()',
        cwd: 'sub'
      })
      assert.equal(result.details.result, join(tempDir, 'sub'))
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('resolves require() packages from the per-call cwd', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'jsrepl-cwd-require-'))
    try {
      mkdirSync(join(tempDir, 'model-cwd', 'node_modules', 'model-only-package'), {
        recursive: true
      })
      writeFileSync(join(tempDir, 'model-cwd', 'package.json'), '{"name":"model-cwd"}')
      writeFileSync(
        join(tempDir, 'model-cwd', 'node_modules', 'model-only-package', 'index.js'),
        'module.exports = { value: "loaded-from-model-cwd" }'
      )

      const tool = createTrackedTool(makeContext({ workspacePath: tempDir }))
      const result = await execute(tool, {
        code: 'require("model-only-package").value',
        cwd: 'model-cwd'
      })

      assert.equal(result.details.result, 'loaded-from-model-cwd')
      assert.equal(result.error, undefined)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('process.env mutations do not leak across calls', async () => {
    const tool = createTrackedTool(makeContext())
    await execute(tool, { code: 'process.env.JS_REPL_TEST_VAR = "leaked"' })
    const result = await execute(tool, {
      code: 'process.env.JS_REPL_TEST_VAR || "not-leaked"'
    })
    assert.equal(result.details.result, 'not-leaked')
  })

  it('rejects absolute cwd', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'jsrepl-cwd-abs-'))
    try {
      const tool = createTrackedTool(makeContext({ workspacePath: tempDir }))
      const result = await execute(tool, { code: '1', cwd: '/etc' })
      assert.ok(result.error?.includes('relative path inside the workspace'))
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('rejects cwd with parent traversal (..)', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'jsrepl-cwd-parent-'))
    try {
      const tool = createTrackedTool(makeContext({ workspacePath: tempDir }))
      const result = await execute(tool, { code: '1', cwd: '../secret' })
      // Zod refinement rejects before execute is reached, or runtime rejection — both surface as error.
      assert.ok(
        result.error?.includes('relative path') || result.error?.includes('..'),
        `unexpected error: ${result.error}`
      )
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('rejects cwd pointing to a non-existent directory', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'jsrepl-cwd-missing-'))
    try {
      const tool = createTrackedTool(makeContext({ workspacePath: tempDir }))
      const result = await execute(tool, { code: '1', cwd: 'does/not/exist' })
      assert.ok(result.error?.includes('does not exist'))
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('rejects cwd that is a file, not a directory', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'jsrepl-cwd-file-'))
    try {
      writeFileSync(join(tempDir, 'a-file.txt'), 'x')
      const tool = createTrackedTool(makeContext({ workspacePath: tempDir }))
      const result = await execute(tool, { code: '1', cwd: 'a-file.txt' })
      assert.ok(result.error?.includes('not a directory'))
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('tools.read honors the per-call cwd for relative paths', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'jsrepl-cwd-tools-'))
    try {
      mkdirSync(join(tempDir, 'sub'))
      writeFileSync(join(tempDir, 'sub', 'hi.txt'), 'sub-contents')
      writeFileSync(join(tempDir, 'hi.txt'), 'root-contents')
      const tool = createTrackedTool(makeContext({ workspacePath: tempDir }))
      const result = await execute(tool, {
        code: '(async () => (await tools.read({ path: "hi.txt" })).content)()',
        cwd: 'sub'
      })
      assert.ok(
        result.details.result?.includes('sub-contents'),
        `expected sub file, got: ${result.details.result}`
      )
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('tools.bash honors the per-call cwd', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'jsrepl-cwd-bash-'))
    try {
      mkdirSync(join(tempDir, 'nested'))
      const tool = createTrackedTool(makeContext({ workspacePath: tempDir }))
      const result = await execute(tool, {
        code: '(async () => (await tools.bash({ command: "pwd" })).content)()',
        cwd: 'nested'
      })
      assert.ok(
        result.details.result?.includes(join(tempDir, 'nested')),
        `expected nested pwd, got: ${result.details.result}`
      )
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('invalid cwd does not wipe persistent state even when reset is set', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'jsrepl-cwd-guard-'))
    try {
      const tool = createTrackedTool(makeContext({ workspacePath: tempDir }))
      await execute(tool, { code: 'var keep = 123', reset: false })
      const failed = await execute(tool, {
        code: 'keep',
        reset: true,
        cwd: 'does/not/exist'
      })
      assert.ok(failed.error?.includes('does not exist'))
      const after = await execute(tool, { code: 'keep', reset: false })
      assert.equal(after.details.result, '123')
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('tools.read reads a file from workspace', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'jsrepl-tools-'))
    try {
      const { writeFileSync } = await import('node:fs')
      writeFileSync(join(tempDir, 'hello.txt'), 'world')
      const tool = createTrackedTool(makeContext({ workspacePath: tempDir }))
      const result = await execute(tool, {
        code: 'const r = await tools.read({ path: "hello.txt" }); return r.content'
      })
      assert.ok(result.details.result?.includes('world'))
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('tools.write creates a file in workspace', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'jsrepl-tools-'))
    try {
      const tool = createTrackedTool(makeContext({ workspacePath: tempDir }))
      await execute(tool, {
        code: 'await tools.write({ path: "out.txt", content: "written by repl" })'
      })
      const { readFileSync } = await import('node:fs')
      assert.equal(readFileSync(join(tempDir, 'out.txt'), 'utf8'), 'written by repl')
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('tools.bash runs a command and returns output', async () => {
    const tool = createTrackedTool(makeContext())
    const result = await execute(tool, {
      code: 'const r = await tools.bash({ command: "echo hello-from-bash" }); return r.content'
    })
    assert.ok(result.details.result?.includes('hello-from-bash'))
  })

  it('tool call errors are returned, not thrown', async () => {
    const tool = createTrackedTool(makeContext())
    const result = await execute(tool, {
      code: 'const r = await tools.read({ path: "/nonexistent/path/file.txt" }); return r.error || "no error"'
    })
    assert.ok(result.details.result !== 'no error')
  })

  it('allows repeated const require() across calls without redeclaration error (persistent mode)', async () => {
    const tool = createTrackedTool(makeContext())
    await execute(tool, { code: 'const fs = require("node:fs"); "first"', reset: false })
    const result = await execute(tool, {
      code: 'const fs = require("node:fs"); "second"',
      reset: false
    })
    assert.equal(result.details.result, 'second')
    assert.equal(result.error, undefined)
  })

  it('allows repeated let require() across calls without redeclaration error (persistent mode)', async () => {
    const tool = createTrackedTool(makeContext())
    await execute(tool, { code: 'let path = require("node:path"); "first"', reset: false })
    const result = await execute(tool, {
      code: 'let path = require("node:path"); path.join("a","b")',
      reset: false
    })
    assert.ok(result.details.result?.includes('a'))
    assert.equal(result.error, undefined)
  })

  it('preserves const/let for non-require declarations (persistent mode)', async () => {
    const tool = createTrackedTool(makeContext())
    await execute(tool, { code: 'const x = 10', reset: false })
    const result = await execute(tool, { code: 'const x = 20', reset: false })
    assert.ok(result.details.error?.includes('has already been declared'))
  })

  it('tools object only includes service-backed tools when services are provided', async () => {
    const tool = createTrackedTool(makeContext())
    const result = await execute(tool, {
      code: 'Object.keys(tools).sort().join(",")'
    })
    // Without searchService/webSearchService, only core tools are available
    assert.equal(result.details.result, 'bash,edit,read,write')
  })
})
