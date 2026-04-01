import assert from 'node:assert/strict'
import test from 'node:test'

import { buildScheduleFormSubmitInput } from './schedulePaneModel.ts'

test('recurring schedule with valid cron', () => {
  const result = buildScheduleFormSubmitInput({
    mode: 'recurring',
    name: 'Daily',
    cron: '0 9 * * *',
    runAt: '',
    prompt: 'Run daily report'
  })

  assert.deepEqual(result, {
    ok: true,
    input: {
      name: 'Daily',
      cronExpression: '0 9 * * *',
      runAt: undefined,
      prompt: 'Run daily report',
      modelOverride: undefined,
      workspacePath: undefined
    }
  })
})

test('recurring schedule requires cron when runAt is empty', () => {
  const result = buildScheduleFormSubmitInput({
    mode: 'recurring',
    name: 'Bad',
    cron: '',
    runAt: '',
    prompt: 'test'
  })

  assert.deepEqual(result, { ok: false, error: 'All fields are required.' })
})

test('one-off schedule with valid runAt', () => {
  const result = buildScheduleFormSubmitInput({
    mode: 'one-off',
    name: 'One-off',
    cron: '',
    runAt: '2099-06-01T09:00',
    prompt: 'Do the thing once'
  })

  assert.ok(result.ok)
  assert.equal(result.input.name, 'One-off')
  assert.equal(result.input.cronExpression, undefined)
  assert.ok(typeof result.input.runAt === 'string')
  // Should be serialized to ISO format
  assert.ok(result.input.runAt?.startsWith('2099-06-01'))
})

test('one-off schedule rejects invalid datetime', () => {
  const result = buildScheduleFormSubmitInput({
    mode: 'one-off',
    name: 'Bad',
    cron: '',
    runAt: 'not-a-date',
    prompt: 'test'
  })

  assert.deepEqual(result, { ok: false, error: 'Invalid date/time for one-off schedule.' })
})

test('edit of one-off schedule preserves runAt and clears cronExpression', () => {
  const result = buildScheduleFormSubmitInput({
    mode: 'one-off',
    initial: {
      id: 'schedule-1',
      name: 'One-off',
      runAt: '2099-06-01T09:00:00.000Z',
      prompt: 'Original prompt',
      enabled: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z'
    },
    name: 'One-off',
    cron: '',
    runAt: '2099-06-01T09:00',
    prompt: 'Updated prompt',
    workspacePath: undefined,
    modelOverride: undefined
  })

  assert.ok(result.ok)
  assert.equal(result.input.name, 'One-off')
  assert.equal(result.input.cronExpression, null)
  assert.equal(result.input.prompt, 'Updated prompt')
  assert.equal(result.input.modelOverride, null)
  assert.equal(result.input.workspacePath, null)
})

test('edit of recurring schedule clears runAt', () => {
  const result = buildScheduleFormSubmitInput({
    mode: 'recurring',
    initial: {
      id: 'schedule-2',
      name: 'Daily',
      cronExpression: '0 9 * * *',
      prompt: 'Original',
      enabled: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z'
    },
    name: 'Daily',
    cron: '0 10 * * *',
    runAt: '',
    prompt: 'Updated'
  })

  assert.ok(result.ok)
  assert.equal(result.input.cronExpression, '0 10 * * *')
  assert.equal(result.input.runAt, null)
})

test('rejects missing name or prompt', () => {
  const base = { mode: 'recurring' as const, cron: '0 9 * * *', runAt: '', prompt: 'test' }

  assert.deepEqual(buildScheduleFormSubmitInput({ ...base, name: '' }), {
    ok: false,
    error: 'All fields are required.'
  })

  assert.deepEqual(buildScheduleFormSubmitInput({ ...base, name: 'Test', prompt: '' }), {
    ok: false,
    error: 'All fields are required.'
  })
})

test('recurring mode ignores stale runAt when toggling from one-off', () => {
  const result = buildScheduleFormSubmitInput({
    mode: 'recurring',
    initial: {
      id: 'schedule-3',
      name: 'One-off',
      runAt: '2099-06-01T09:00:00.000Z',
      prompt: 'Original',
      enabled: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z'
    },
    name: 'Converted',
    cron: '0 10 * * *',
    runAt: '2099-06-01T09:00',
    prompt: 'Updated'
  })

  assert.ok(result.ok)
  assert.equal(result.input.cronExpression, '0 10 * * *')
  assert.equal(result.input.runAt, null)
})

test('one-off mode ignores stale cron when toggling from recurring', () => {
  const result = buildScheduleFormSubmitInput({
    mode: 'one-off',
    initial: {
      id: 'schedule-4',
      name: 'Recurring',
      cronExpression: '0 9 * * *',
      prompt: 'Original',
      enabled: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z'
    },
    name: 'Converted',
    cron: '0 9 * * *',
    runAt: '2099-07-01T08:30',
    prompt: 'Updated'
  })

  assert.ok(result.ok)
  assert.equal(result.input.cronExpression, null)
  assert.ok(result.input.runAt?.startsWith('2099-07-01'))
})
