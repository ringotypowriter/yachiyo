import assert from 'node:assert/strict'
import test from 'node:test'

import { isRetryableModelError } from './retryableModelError.ts'

test('isRetryableModelError honors explicit and status-based decisions', () => {
  const abortError = new Error('Aborted')
  abortError.name = 'AbortError'

  const unauthorized = new Error('Unauthorized')
  ;(unauthorized as { status?: number }).status = 401

  const unavailable = new Error('Service Unavailable')
  ;(unavailable as { status?: number }).status = 503

  const browserTransportError = new Error('net::ERR_CONNECTION_CLOSED')
  ;(browserTransportError as { status?: number }).status = 0

  assert.equal(isRetryableModelError(abortError), false)
  assert.equal(isRetryableModelError({ isRetryable: true }), true)
  assert.equal(isRetryableModelError({ isRetryable: false }), false)
  assert.equal(isRetryableModelError(unauthorized), false)
  assert.equal(isRetryableModelError(unavailable), true)
  assert.equal(isRetryableModelError(browserTransportError), true)
})

test('isRetryableModelError matches transient network code and message signatures', () => {
  const nodeNetworkError = new Error('read ECONNRESET')
  ;(nodeNetworkError as { code?: string }).code = 'ECONNRESET'

  const fetchWrappedNetworkError = new Error(
    'request to https://api.example.com failed, reason: read ECONNRESET'
  )

  const socketHangup = new Error('socket hang up')

  assert.equal(isRetryableModelError(nodeNetworkError), true)
  assert.equal(isRetryableModelError(fetchWrappedNetworkError), true)
  assert.equal(isRetryableModelError(socketHangup), true)
})
