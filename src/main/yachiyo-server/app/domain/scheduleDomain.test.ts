import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { ScheduleDomain } from './scheduleDomain.ts'
import type { ScheduleRecord, ScheduleRunRecord } from '../../../../shared/yachiyo/protocol.ts'

interface MockStorage {
  schedules: Map<string, ScheduleRecord>
  runs: ScheduleRunRecord[]
  listSchedules: () => ScheduleRecord[]
  getSchedule: (id: string) => ScheduleRecord | undefined
  createSchedule: (s: ScheduleRecord) => void
  updateSchedule: (s: ScheduleRecord) => void
  deleteSchedule: (id: string) => void
  createScheduleRun: (r: ScheduleRunRecord) => void
  completeScheduleRun: () => void
  listScheduleRuns: () => ScheduleRunRecord[]
  listRecentScheduleRuns: () => ScheduleRunRecord[]
  recoverInterruptedScheduleRuns: () => void
}

function createMockStorage(): MockStorage {
  const schedules = new Map<string, ScheduleRecord>()
  const runs: ScheduleRunRecord[] = []

  return {
    schedules,
    runs,
    listSchedules: () => [...schedules.values()].sort((a, b) => a.name.localeCompare(b.name)),
    getSchedule: (id: string) => schedules.get(id),
    createSchedule: (s: ScheduleRecord) => {
      schedules.set(s.id, s)
    },
    updateSchedule: (s: ScheduleRecord) => {
      schedules.set(s.id, s)
    },
    deleteSchedule: (id: string) => {
      schedules.delete(id)
    },
    createScheduleRun: (r: ScheduleRunRecord) => {
      runs.push(r)
    },
    completeScheduleRun: () => {
      // no-op for test
    },
    listScheduleRuns: () => runs,
    listRecentScheduleRuns: () => runs,
    recoverInterruptedScheduleRuns: () => {
      // no-op for test
    }
  }
}

function createDomain(storage: MockStorage = createMockStorage()): {
  domain: ScheduleDomain
  storage: MockStorage
} {
  let idCounter = 0
  return {
    domain: new ScheduleDomain({
      storage: storage as never,
      createId: () => `test-${++idCounter}`,
      timestamp: () => '2026-01-01T00:00:00.000Z'
    }),
    storage
  }
}

describe('ScheduleDomain', () => {
  describe('createSchedule', () => {
    it('creates a schedule with valid cron expression', () => {
      const { domain } = createDomain()
      const schedule = domain.createSchedule({
        name: 'Daily Report',
        cronExpression: '0 9 * * *',
        prompt: 'Generate daily report'
      })

      assert.equal(schedule.name, 'Daily Report')
      assert.equal(schedule.cronExpression, '0 9 * * *')
      assert.equal(schedule.runAt, undefined)
      assert.equal(schedule.prompt, 'Generate daily report')
      assert.equal(schedule.enabled, true)
      assert.equal(schedule.id, 'test-1')
    })

    it('creates a one-off schedule with runAt', () => {
      const { domain } = createDomain()
      const schedule = domain.createSchedule({
        name: 'One-off Task',
        runAt: '2099-06-01T09:00:00.000Z',
        prompt: 'Do the thing once'
      })

      assert.equal(schedule.name, 'One-off Task')
      assert.equal(schedule.runAt, '2099-06-01T09:00:00.000Z')
      assert.equal(schedule.cronExpression, undefined)
      assert.equal(schedule.enabled, true)
    })

    it('rejects neither cronExpression nor runAt', () => {
      const { domain } = createDomain()
      assert.throws(
        () => domain.createSchedule({ name: 'Bad', prompt: 'test' }),
        /cronExpression or runAt/i
      )
    })

    it('rejects both cronExpression and runAt', () => {
      const { domain } = createDomain()
      assert.throws(
        () =>
          domain.createSchedule({
            name: 'Conflict',
            cronExpression: '0 9 * * *',
            runAt: '2099-06-01T09:00:00.000Z',
            prompt: 'test'
          }),
        /not both/i
      )
    })

    it('rejects invalid cron expression', () => {
      const { domain } = createDomain()
      assert.throws(
        () =>
          domain.createSchedule({
            name: 'Bad',
            cronExpression: 'not a cron',
            prompt: 'test'
          }),
        /invalid cron expression/i
      )
    })

    it('rejects invalid runAt datetime', () => {
      const { domain } = createDomain()
      assert.throws(
        () =>
          domain.createSchedule({
            name: 'Bad',
            runAt: 'not-a-date',
            prompt: 'test'
          }),
        /invalid runAt/i
      )
    })

    it('rejects empty name', () => {
      const { domain } = createDomain()
      assert.throws(
        () =>
          domain.createSchedule({
            name: '  ',
            cronExpression: '0 9 * * *',
            prompt: 'test'
          }),
        /name/i
      )
    })

    it('rejects empty prompt', () => {
      const { domain } = createDomain()
      assert.throws(
        () =>
          domain.createSchedule({
            name: 'Test',
            cronExpression: '0 9 * * *',
            prompt: '  '
          }),
        /prompt/i
      )
    })

    it('respects enabled=false override', () => {
      const { domain } = createDomain()
      const schedule = domain.createSchedule({
        name: 'Disabled',
        cronExpression: '0 9 * * *',
        prompt: 'test',
        enabled: false
      })

      assert.equal(schedule.enabled, false)
    })

    it('stores optional fields', () => {
      const { domain } = createDomain()
      const schedule = domain.createSchedule({
        name: 'With Options',
        cronExpression: '*/5 * * * *',
        prompt: 'do stuff',
        workspacePath: '/tmp/test',
        modelOverride: { providerName: 'openai', model: 'gpt-4o' },
        enabledTools: ['read', 'bash']
      })

      assert.equal(schedule.workspacePath, '/tmp/test')
      assert.deepEqual(schedule.modelOverride, { providerName: 'openai', model: 'gpt-4o' })
      assert.deepEqual(schedule.enabledTools, ['read', 'bash'])
    })
  })

  describe('updateSchedule', () => {
    it('updates existing schedule fields', () => {
      const { domain } = createDomain()
      domain.createSchedule({
        name: 'Original',
        cronExpression: '0 9 * * *',
        prompt: 'original prompt'
      })

      const updated = domain.updateSchedule({
        id: 'test-1',
        name: 'Updated',
        prompt: 'new prompt'
      })

      assert.equal(updated.name, 'Updated')
      assert.equal(updated.prompt, 'new prompt')
      assert.equal(updated.cronExpression, '0 9 * * *') // unchanged
    })

    it('throws for non-existent schedule', () => {
      const { domain } = createDomain()
      assert.throws(() => domain.updateSchedule({ id: 'nope' }), /not found/i)
    })

    it('validates new cron expression', () => {
      const { domain } = createDomain()
      domain.createSchedule({
        name: 'Test',
        cronExpression: '0 9 * * *',
        prompt: 'test'
      })

      assert.throws(
        () => domain.updateSchedule({ id: 'test-1', cronExpression: 'bad' }),
        /invalid cron expression/i
      )
    })

    it('clears optional fields with null', () => {
      const { domain } = createDomain()
      domain.createSchedule({
        name: 'Test',
        cronExpression: '0 9 * * *',
        prompt: 'test',
        workspacePath: '/tmp/ws',
        modelOverride: { providerName: 'openai', model: 'gpt-4o' }
      })

      const updated = domain.updateSchedule({
        id: 'test-1',
        workspacePath: null,
        modelOverride: null
      })

      assert.equal(updated.workspacePath, undefined)
      assert.equal(updated.modelOverride, undefined)
    })

    it('converts cron schedule to one-off by setting runAt and clearing cronExpression', () => {
      const { domain } = createDomain()
      domain.createSchedule({
        name: 'Switch',
        cronExpression: '0 9 * * *',
        prompt: 'test'
      })

      const updated = domain.updateSchedule({
        id: 'test-1',
        cronExpression: null,
        runAt: '2099-12-31T23:59:00.000Z'
      })

      assert.equal(updated.cronExpression, undefined)
      assert.equal(updated.runAt, '2099-12-31T23:59:00.000Z')
    })

    it('rejects update that leaves schedule with no scheduling mode', () => {
      const { domain } = createDomain()
      domain.createSchedule({
        name: 'Test',
        cronExpression: '0 9 * * *',
        prompt: 'test'
      })

      assert.throws(
        () => domain.updateSchedule({ id: 'test-1', cronExpression: null }),
        /cronExpression or runAt/i
      )
    })

    it('rejects update that leaves schedule with both scheduling modes', () => {
      const { domain } = createDomain()
      domain.createSchedule({
        name: 'Test',
        runAt: '2099-06-01T09:00:00.000Z',
        prompt: 'test'
      })

      assert.throws(
        () =>
          domain.updateSchedule({
            id: 'test-1',
            cronExpression: '0 9 * * *'
            // runAt still present on existing record
          }),
        /both/i
      )
    })

    it('rejects blank name on update', () => {
      const { domain } = createDomain()
      domain.createSchedule({
        name: 'Test',
        cronExpression: '0 9 * * *',
        prompt: 'test'
      })

      assert.throws(() => domain.updateSchedule({ id: 'test-1', name: '  ' }), /name/i)
    })

    it('rejects blank prompt on update', () => {
      const { domain } = createDomain()
      domain.createSchedule({
        name: 'Test',
        cronExpression: '0 9 * * *',
        prompt: 'test'
      })

      assert.throws(() => domain.updateSchedule({ id: 'test-1', prompt: '' }), /prompt/i)
    })
  })

  describe('deleteSchedule', () => {
    it('deletes existing schedule', () => {
      const { domain, storage } = createDomain()
      domain.createSchedule({
        name: 'ToDelete',
        cronExpression: '0 9 * * *',
        prompt: 'test'
      })
      assert.equal(storage.schedules.size, 1)

      domain.deleteSchedule('test-1')
      assert.equal(storage.schedules.size, 0)
    })

    it('throws for non-existent schedule', () => {
      const { domain } = createDomain()
      assert.throws(() => domain.deleteSchedule('nope'), /not found/i)
    })
  })

  describe('enableSchedule / disableSchedule', () => {
    it('toggles enabled state', () => {
      const { domain } = createDomain()
      domain.createSchedule({
        name: 'Toggle',
        cronExpression: '0 9 * * *',
        prompt: 'test'
      })

      const disabled = domain.disableSchedule('test-1')
      assert.equal(disabled.enabled, false)

      const enabled = domain.enableSchedule('test-1')
      assert.equal(enabled, true)
    })
  })

  describe('listSchedules', () => {
    it('returns all schedules sorted by name', () => {
      const { domain } = createDomain()
      domain.createSchedule({ name: 'Zeta', cronExpression: '0 9 * * *', prompt: 'z' })
      domain.createSchedule({ name: 'Alpha', cronExpression: '0 9 * * *', prompt: 'a' })

      const list = domain.listSchedules()
      assert.equal(list.length, 2)
      assert.equal(list[0].name, 'Alpha')
      assert.equal(list[1].name, 'Zeta')
    })
  })

  describe('bundled schedules', () => {
    it('ensureBundledSchedules creates the self-review schedule when missing', () => {
      const { domain, storage } = createDomain()
      domain.ensureBundledSchedules()

      const schedule = storage.schedules.get('bundled:self-review')
      assert.ok(schedule, 'bundled:self-review should exist')
      assert.equal(schedule.name, 'Self-Review')
      assert.equal(schedule.cronExpression, '0 12 * * *')
      assert.equal(schedule.enabled, true)
      assert.ok(schedule.prompt.length > 100, 'prompt should contain the full self-review text')
    })

    it('ensureBundledSchedules is idempotent', () => {
      const { domain, storage } = createDomain()
      domain.ensureBundledSchedules()
      const firstPrompt = storage.schedules.get('bundled:self-review')!.prompt

      domain.ensureBundledSchedules()
      assert.equal(storage.schedules.get('bundled:self-review')!.prompt, firstPrompt)
    })

    it('ensureBundledSchedules refreshes prompt when code changes', () => {
      const storage = createMockStorage()
      const now = '2026-01-01T00:00:00.000Z'
      storage.schedules.set('bundled:self-review', {
        id: 'bundled:self-review',
        name: 'Self-Review',
        cronExpression: '0 12 * * *',
        prompt: 'old prompt text',
        enabled: false, // user disabled it
        createdAt: now,
        updatedAt: now
      })

      const { domain } = createDomain(storage)
      domain.ensureBundledSchedules()

      const updated = storage.schedules.get('bundled:self-review')!
      assert.notEqual(updated.prompt, 'old prompt text', 'prompt should be refreshed')
      assert.equal(updated.enabled, false, 'enabled preference should be preserved')
      assert.equal(updated.cronExpression, '0 12 * * *', 'cron should be preserved')
    })

    it('ensureBundledSchedules restores default cron when converted to one-off', () => {
      const storage = createMockStorage()
      const now = '2026-01-01T00:00:00.000Z'
      storage.schedules.set('bundled:self-review', {
        id: 'bundled:self-review',
        name: 'Self-Review',
        runAt: '2026-06-01T09:00:00.000Z', // was converted to one-off
        prompt: 'old prompt',
        enabled: false, // was auto-disabled after one-off fired
        createdAt: now,
        updatedAt: now
      })

      const { domain } = createDomain(storage)
      domain.ensureBundledSchedules()

      const restored = storage.schedules.get('bundled:self-review')!
      assert.equal(restored.cronExpression, '0 12 * * *', 'should restore default cron')
      assert.equal(restored.runAt, undefined, 'should clear runAt')
      assert.equal(restored.enabled, true, 'should re-enable')
    })

    it('updateSchedule rejects name changes on bundled schedules', () => {
      const { domain } = createDomain()
      domain.ensureBundledSchedules()

      assert.throws(
        () => domain.updateSchedule({ id: 'bundled:self-review', name: 'Custom Name' }),
        /cannot change the name/i
      )
    })

    it('updateSchedule rejects prompt changes on bundled schedules', () => {
      const { domain } = createDomain()
      domain.ensureBundledSchedules()

      assert.throws(
        () => domain.updateSchedule({ id: 'bundled:self-review', prompt: 'custom prompt' }),
        /cannot change the prompt/i
      )
    })

    it('updateSchedule rejects conversion to one-off on bundled schedules', () => {
      const { domain } = createDomain()
      domain.ensureBundledSchedules()

      assert.throws(
        () =>
          domain.updateSchedule({
            id: 'bundled:self-review',
            cronExpression: null,
            runAt: '2099-12-31T23:59:00.000Z'
          }),
        /cannot convert a bundled schedule to one-off/i
      )
    })

    it('updateSchedule allows cron changes on bundled schedules', () => {
      const { domain } = createDomain()
      domain.ensureBundledSchedules()

      const updated = domain.updateSchedule({
        id: 'bundled:self-review',
        cronExpression: '0 3 * * *' // user prefers 3 AM
      })
      assert.equal(updated.cronExpression, '0 3 * * *')
    })

    it('updateSchedule allows updates that repeat the current bundled name/prompt', () => {
      const { domain } = createDomain()
      domain.ensureBundledSchedules()
      const existing = domain.getSchedule('bundled:self-review')

      const updated = domain.updateSchedule({
        id: 'bundled:self-review',
        name: existing.name,
        prompt: existing.prompt,
        cronExpression: '30 12 * * *'
      })
      assert.equal(updated.cronExpression, '30 12 * * *')
      assert.equal(updated.name, existing.name)
      assert.equal(updated.prompt, existing.prompt)
    })

    it('deleteSchedule rejects bundled schedules', () => {
      const { domain } = createDomain()
      domain.ensureBundledSchedules()

      assert.throws(
        () => domain.deleteSchedule('bundled:self-review'),
        /bundled schedules cannot be deleted/i
      )
    })

    it('disableSchedule works on bundled schedules', () => {
      const { domain } = createDomain()
      domain.ensureBundledSchedules()

      const disabled = domain.disableSchedule('bundled:self-review')
      assert.equal(disabled.enabled, false)
    })

    it('listSchedules hydrates bundled flag', () => {
      const { domain } = createDomain()
      domain.ensureBundledSchedules()
      domain.createSchedule({ name: 'User Schedule', cronExpression: '0 9 * * *', prompt: 'test' })

      const list = domain.listSchedules()
      const bundled = list.find((s) => s.id === 'bundled:self-review')
      const user = list.find((s) => s.id !== 'bundled:self-review')

      assert.equal(bundled?.bundled, true)
      assert.equal(user?.bundled, undefined)
    })

    it('getSchedule hydrates bundled flag', () => {
      const { domain } = createDomain()
      domain.ensureBundledSchedules()

      const schedule = domain.getSchedule('bundled:self-review')
      assert.equal(schedule.bundled, true)
    })
  })
})
