import assert from 'node:assert/strict'
import vm from 'node:vm'
import { describe, it } from 'node:test'

import { compileJsReplCell } from './jsReplCellCompiler.ts'
import {
  formatJsReplError,
  formatToolInputValidationError,
  JS_REPL_SCRIPT_FILENAME
} from './jsReplErrorFormat.ts'

/** Run a cell the way the worker does and return the formatted failure. */
async function failureFor(code: string): Promise<string> {
  let compiled
  try {
    compiled = compileJsReplCell(code)
  } catch (error) {
    return formatJsReplError(error, { code })
  }
  const context = vm.createContext({ Promise, setTimeout, JSON })
  try {
    await new vm.Script(compiled.source, { filename: JS_REPL_SCRIPT_FILENAME }).runInContext(
      context,
      { timeout: 5_000 }
    )
    assert.fail('expected the cell to fail')
  } catch (error) {
    return formatJsReplError(error, { code, sourceOrigins: compiled.sourceOrigins })
  }
}

describe('formatJsReplError', () => {
  it('reports the line the model wrote, not the line the wrapper generated', async () => {
    const output = await failureFor(['const a = 1', 'const b = missingBinding + 2', 'b'].join('\n'))

    assert.match(output, /^ReferenceError: missingBinding is not defined$/m)
    assert.match(output, /at jsRepl:2:11$/m)
    assert.match(output, /^> 2 \| const b = missingBinding \+ 2$/m)
    assert.match(output, /^ {4}\| {11}\^$/m)
  })

  it('keeps the whole call chain in author coordinates', async () => {
    const output = await failureFor(
      ['function boom() { throw new Error("kaboom") }', 'const unused = 1', 'boom()'].join('\n')
    )

    assert.match(output, /^Error: kaboom$/m)
    assert.match(output, /at boom \(jsRepl:1:25\)$/m)
    assert.match(output, /at jsRepl:3:1$/m)
  })

  it('drops vm, worker and packaged-runtime frames', async () => {
    const output = await failureFor('throw new Error("boom")')

    for (const line of output.split('\n')) {
      if (!line.trimStart().startsWith('at ')) continue
      assert.match(line, /jsRepl:\d+:\d+/, `internal frame leaked: ${line}`)
    }
    assert.doesNotMatch(output, /node:vm|node:internal|app\.asar|jsReplWorker/)
  })

  it('renders a syntax error as a caret instead of a parser stack', async () => {
    const output = await failureFor('const x = (')

    assert.match(output, /^SyntaxError: /m)
    assert.match(output, /^> 1 \| const x = \($/m)
    assert.doesNotMatch(output, /@babel|node_modules|\.pnpm/)
  })

  it('falls back to the message alone when no author frame survives', async () => {
    const output = await failureFor('export const x = 1')

    assert.equal(output, 'Error: JavaScript REPL cells do not support export declarations.')
  })

  it('maps frames from the cause when the thrown wrapper has none', () => {
    const code = 'const later = 1\nsetTimeout(() => { throw new Error("timer boom") })'
    const compiled = compileJsReplCell(code)
    const compiledLine = compiled.sourceOrigins.findIndex((origin) => origin?.line === 2) + 1
    const authorColumn = 20
    const compiledColumn = authorColumn + compiled.sourceOrigins[compiledLine - 1]!.columnDelta
    const cause = new Error('timer boom')
    cause.stack = [
      'Error: timer boom',
      `    at jsRepl:${compiledLine}:${compiledColumn}`,
      '    at listOnTimeout (node:internal/timers:1:1)'
    ].join('\n')
    const wrapper = new Error('Unhandled asynchronous error: timer boom', { cause })
    wrapper.stack =
      'Error: Unhandled asynchronous error: timer boom\n    at executeCell (/app.asar/worker.js:1:1)'

    const output = formatJsReplError(wrapper, { code, sourceOrigins: compiled.sourceOrigins })

    assert.match(output, /^Error: Unhandled asynchronous error: timer boom$/m)
    assert.match(output, new RegExp(`at jsRepl:2:${authorColumn}$`, 'm'))
    assert.doesNotMatch(output, /app\.asar|node:internal/)
  })
})

describe('formatToolInputValidationError', () => {
  it('names the offending fields instead of restating the issue JSON', () => {
    const error = Object.assign(new Error('[{"code":"invalid_type"}]'), {
      issues: [
        { path: ['path'], message: 'Expected string, received number' },
        { path: ['limit'], message: 'Too big' }
      ]
    })

    assert.equal(
      formatToolInputValidationError('read', error),
      'Invalid input for tool "read": path: Expected string, received number; limit: Too big'
    )
  })

  it('falls back to the error message when there are no issues', () => {
    assert.equal(
      formatToolInputValidationError('read', new Error('schema unavailable')),
      'Invalid input for tool "read": Error: schema unavailable'
    )
  })
})
