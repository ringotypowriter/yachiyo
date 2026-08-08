import assert from 'node:assert/strict'
import test from 'node:test'

import { createInMemoryYachiyoStorage } from './memoryStorage.ts'

/**
 * Orderings the in-memory store has to match because sqlite decides them.
 *
 * Where sqlite sorts in SQL, the collation is BINARY and is not going to
 * change; the drift can only come from the JavaScript side comparing some
 * other way. So these lock the JavaScript side against what sqlite will do,
 * rather than running the same assertions twice.
 */

const SCHEDULE_NAMES = ['Daily digest', 'archive cleanup', 'Backup', 'zeta task', 'Alpha']

test('schedules are listed in the same order sqlite would list them', () => {
  const storage = createInMemoryYachiyoStorage()
  for (const [index, name] of SCHEDULE_NAMES.entries()) {
    storage.createSchedule({
      id: `schedule-${index}`,
      name,
      prompt: 'noop',
      cronExpression: '0 0 * * *',
      enabled: true,
      createdAt: '2026-03-20T00:00:00.000Z',
      updatedAt: '2026-03-20T00:00:00.000Z'
    })
  }

  // sqlite sorts this list with `order by name`, which compares by code unit:
  // every uppercase letter sorts before every lowercase one. `localeCompare`
  // instead groups them case-insensitively and puts `archive cleanup` second.
  // Schedule names are user text, so this is an ordinary case, not an edge one.
  assert.deepEqual(
    storage.listSchedules().map((schedule) => schedule.name),
    ['Alpha', 'Backup', 'Daily digest', 'archive cleanup', 'zeta task']
  )

  storage.close()
})
