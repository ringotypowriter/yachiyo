import assert from 'node:assert/strict'
import test from 'node:test'

import { extractRetryErrorMessage } from './runFailureHandling.ts'

test('extractRetryErrorMessage keeps HTTP 401 visible for auth failures', () => {
  const error = new Error('Unauthorized')
  ;(error as { status?: number }).status = 401

  assert.equal(extractRetryErrorMessage(error), 'Unauthorized (HTTP 401)')
})

test('extractRetryErrorMessage shows HTTP 401 even when the provider error has no message', () => {
  const error = new Error('')
  ;(error as { status?: number }).status = 401

  assert.equal(extractRetryErrorMessage(error), 'Authentication failed (HTTP 401)')
})
