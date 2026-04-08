import assert from 'node:assert/strict'
import test from 'node:test'

import {
  RetryableRunError,
  isRetryableRunError,
  isTransientTransportError,
  toRunBoundaryError
} from './runtimeErrors.ts'

test('RetryableRunError is an Error with a stable name and cause chain', () => {
  const cause = new Error('underlying 503')
  const wrapped = new RetryableRunError('service unavailable', { cause })

  assert.ok(wrapped instanceof Error)
  assert.ok(wrapped instanceof RetryableRunError)
  assert.equal(wrapped.name, 'RetryableRunError')
  assert.equal(wrapped.message, 'service unavailable')
  assert.equal(wrapped.cause, cause)
  assert.equal(isRetryableRunError(wrapped), true)
  assert.equal(isRetryableRunError(cause), false)
  assert.equal(isRetryableRunError(null), false)
  assert.equal(isRetryableRunError('retryable'), false)
})

test('isTransientTransportError honors explicit isRetryable flag', () => {
  assert.equal(isTransientTransportError({ isRetryable: true }), true)
  assert.equal(isTransientTransportError({ isRetryable: false }), false)
})

test('isTransientTransportError classifies HTTP statuses', () => {
  const mk = (status: number): Error => Object.assign(new Error(`HTTP ${status}`), { status })
  // Browser-side transport surfaces as status 0.
  assert.equal(isTransientTransportError(mk(0)), true)
  assert.equal(isTransientTransportError(mk(429)), true)
  assert.equal(isTransientTransportError(mk(500)), true)
  assert.equal(isTransientTransportError(mk(503)), true)
  // Non-transient 4xx.
  assert.equal(isTransientTransportError(mk(400)), false)
  assert.equal(isTransientTransportError(mk(401)), false)
  assert.equal(isTransientTransportError(mk(403)), false)
  assert.equal(isTransientTransportError(mk(404)), false)
  // An unknown 4xx that is not specifically listed — not a transport fault.
  assert.equal(isTransientTransportError(mk(418)), false)
})

test('isTransientTransportError matches known network error codes', () => {
  const codes = [
    'ECONNRESET',
    'ETIMEDOUT',
    'ECONNREFUSED',
    'ENOTFOUND',
    'ERR_CONNECTION_CLOSED',
    'UND_ERR_SOCKET',
    'UND_ERR_CONNECT_TIMEOUT'
  ]
  for (const code of codes) {
    const err = Object.assign(new Error(`driver: ${code}`), { code })
    assert.equal(isTransientTransportError(err), true, code)
  }
})

test('isTransientTransportError matches known network message signatures', () => {
  assert.equal(isTransientTransportError(new Error('fetch failed')), true)
  assert.equal(isTransientTransportError(new Error('socket hang up')), true)
  assert.equal(
    isTransientTransportError(
      new Error('request to https://api.example.com failed, reason: read ECONNRESET')
    ),
    true
  )
})

test('isTransientTransportError defaults to false for unknown errors', () => {
  // Plain logic bug — no status, no code, no network signature.
  assert.equal(isTransientTransportError(new Error('Cannot read properties of undefined')), false)
  // String error.
  assert.equal(isTransientTransportError('oops'), false)
  // Null/undefined.
  assert.equal(isTransientTransportError(null), false)
  assert.equal(isTransientTransportError(undefined), false)
})

test('isTransientTransportError rejects storage/ORM-shaped errors', () => {
  // better-sqlite3 SqliteError shape (name + code starting with SQLITE_).
  // Even though the code is a string, none of the network code patterns
  // match, there is no status, and no network message — so the default-false
  // branch takes over and the error is correctly treated as non-transient.
  const sqliteError = Object.assign(new Error('database is locked'), {
    name: 'SqliteError',
    code: 'SQLITE_BUSY'
  })
  assert.equal(isTransientTransportError(sqliteError), false)

  // drizzle-orm DrizzleError shape.
  const drizzleError = Object.assign(new Error('Rollback'), { name: 'DrizzleError' })
  assert.equal(isTransientTransportError(drizzleError), false)

  // drizzle-orm DrizzleQueryError shape: no distinctive name, just own
  // properties for query/params/cause.
  const drizzleQueryError = Object.assign(new Error('Failed query: insert into "runs"\nparams: '), {
    query: 'insert into "runs"',
    params: [],
    cause: sqliteError
  })
  assert.equal(isTransientTransportError(drizzleQueryError), false)
})

test('toRunBoundaryError wraps transient errors and preserves non-transient ones', () => {
  // Transient → wrapped with the original as cause, message preserved so
  // existing `{ message: ... }` assertions in the test suite keep working.
  const transient = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })
  const wrapped = toRunBoundaryError(transient)
  assert.ok(wrapped instanceof RetryableRunError)
  assert.equal((wrapped as RetryableRunError).message, 'read ECONNRESET')
  assert.equal((wrapped as RetryableRunError).cause, transient)

  // Non-transient (401) → pass-through, same reference.
  const unauthorized = Object.assign(new Error('Unauthorized'), { status: 401 })
  assert.equal(toRunBoundaryError(unauthorized), unauthorized)

  // AbortError → pass-through (classification is signal-driven, not by type).
  const aborted = new Error('Aborted')
  aborted.name = 'AbortError'
  assert.equal(toRunBoundaryError(aborted), aborted)

  // Storage error → pass-through (fatal).
  const sqliteError = Object.assign(new Error('database is locked'), {
    name: 'SqliteError',
    code: 'SQLITE_BUSY'
  })
  assert.equal(toRunBoundaryError(sqliteError), sqliteError)

  // Already-wrapped → idempotent (same reference).
  const alreadyWrapped = new RetryableRunError('already wrapped')
  assert.equal(toRunBoundaryError(alreadyWrapped), alreadyWrapped)
})
