const SCRIPT_RESULT_MARKER = '__yachiyoBrowserAutomationScriptResult'
const GENERIC_ELECTRON_SCRIPT_FAILURE = 'Script failed to execute'

export interface BrowserAutomationScriptContext {
  action?: string
  session?: string
  url?: string
}

interface BrowserAutomationScriptErrorPayload {
  name: string
  message: string
  stack?: string
}

type BrowserAutomationScriptWrappedResult<TResult> =
  | {
      [SCRIPT_RESULT_MARKER]: true
      ok: true
      value: TResult
    }
  | {
      [SCRIPT_RESULT_MARKER]: true
      ok: false
      error: BrowserAutomationScriptErrorPayload
    }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function contextLabel(context: BrowserAutomationScriptContext): string {
  const action = context.action ? `${context.action} script` : 'automation script'
  const session = context.session ? ` in session "${context.session}"` : ''
  const url = context.url ? ` at ${context.url}` : ''
  return `${action}${session}${url}`
}

function errorName(error: BrowserAutomationScriptErrorPayload): string {
  return error.name && error.name !== 'Error' ? `${error.name}: ` : ''
}

function compactStack(stack: string | undefined): string | undefined {
  if (!stack) return undefined
  const trimmed = stack
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 8)
    .join('\n')
  return trimmed ? trimmed.slice(0, 2_000) : undefined
}

function wrapBrowserAutomationPageScriptExpression(expression: string, timeoutMs?: number): string {
  return `(() => {
    const marker = ${JSON.stringify(SCRIPT_RESULT_MARKER)}
    const timeoutMs = ${JSON.stringify(timeoutMs)}
    const ok = (value) => ({ [marker]: true, ok: true, value })
    const fail = (error) => {
      const record = error && typeof error === 'object' ? error : undefined
      return {
        [marker]: true,
        ok: false,
        error: {
          name: record && 'name' in record ? String(record.name || 'Error') : 'Error',
          message: record && 'message' in record ? String(record.message || 'Unknown browser script error.') : String(error || 'Unknown browser script error.'),
          stack: record && 'stack' in record && record.stack ? String(record.stack) : undefined
        }
      }
    }

    try {
      const run = Promise.resolve(${expression})
      if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        return run.then(ok, fail)
      }

      let timeoutId
      const timeout = new Promise((_resolve, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error('Timed out after ' + timeoutMs + 'ms running browser eval script.')),
          timeoutMs
        )
      })

      return Promise.race([run, timeout]).then(
        (value) => {
          clearTimeout(timeoutId)
          return ok(value)
        },
        (error) => {
          clearTimeout(timeoutId)
          return fail(error)
        }
      )
    } catch (error) {
      return fail(error)
    }
  })()`
}

export function wrapBrowserAutomationPageScript(script: string): string {
  return wrapBrowserAutomationPageScriptExpression(`(${script})`)
}

export function wrapBrowserAutomationPageEvalScript(script: string, timeoutMs?: number): string {
  return wrapBrowserAutomationPageScriptExpression(
    `(async () => {
${script}
  })()`,
    timeoutMs
  )
}

export function unwrapBrowserAutomationPageScriptResult<TResult>(
  result: unknown,
  context: BrowserAutomationScriptContext
): TResult {
  if (!isRecord(result) || result[SCRIPT_RESULT_MARKER] !== true) {
    throw new Error(`Browser ${contextLabel(context)} returned an invalid result.`)
  }

  const wrapped = result as BrowserAutomationScriptWrappedResult<TResult>
  if (wrapped.ok) {
    return wrapped.value
  }

  const message = `Browser ${contextLabel(context)} failed: ${errorName(wrapped.error)}${wrapped.error.message}`
  const stack = compactStack(wrapped.error.stack)
  throw new Error(stack ? `${message}\n${stack}` : message)
}

export function normalizeBrowserAutomationScriptExecutionError(
  error: unknown,
  context: BrowserAutomationScriptContext
): Error {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes(GENERIC_ELECTRON_SCRIPT_FAILURE)) {
    return new Error(
      `Browser ${contextLabel(context)} could not run. The page may still be navigating, or Electron rejected the script before it could report the page error. Wait for the page to finish loading, then try the browser action again.`
    )
  }

  return error instanceof Error ? error : new Error(message)
}
