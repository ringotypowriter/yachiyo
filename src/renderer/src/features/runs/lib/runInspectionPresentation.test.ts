import assert from 'node:assert/strict'
import test from 'node:test'

import { buildRunInspectionViewModel } from './runInspectionPresentation.ts'

const BASE_RUN = {
  id: 'run-1',
  threadId: 'thread-1',
  status: 'completed' as const,
  createdAt: '2026-03-17T00:00:00.000Z',
  completedAt: '2026-03-17T00:00:05.000Z',
  requestMessageId: 'msg-1'
}

const BASE_TOOL_CALL = {
  id: 'tool-1',
  runId: 'run-1',
  threadId: 'thread-1',
  toolName: 'bash' as const,
  status: 'completed' as const,
  inputSummary: 'ls -la',
  startedAt: '2026-03-17T00:00:01.000Z',
  finishedAt: '2026-03-17T00:00:02.000Z'
}

// ---- Empty / null cases ----

test('buildRunInspectionViewModel returns null run when runs is empty', () => {
  const vm = buildRunInspectionViewModel([], [], null, 0)

  assert.equal(vm.run, null)
  assert.deepEqual(vm.toolCalls, [])
})

test('buildRunInspectionViewModel always includes thread context source', () => {
  const vm = buildRunInspectionViewModel([], [], { workspacePath: '/home/user/proj' }, 5)

  const thread = vm.contextSources.find((s) => s.kind === 'thread')
  assert.ok(thread && thread.kind === 'thread', 'thread source must be present')
  assert.equal(thread.messageCount, 5)
  assert.equal(thread.workspacePath, '/home/user/proj')
})

test('buildRunInspectionViewModel thread source has null workspacePath when not set', () => {
  const vm = buildRunInspectionViewModel([], [], {}, 3)

  const thread = vm.contextSources.find((s) => s.kind === 'thread')
  assert.ok(thread && thread.kind === 'thread')
  assert.equal(thread.workspacePath, null)
})

test('buildRunInspectionViewModel thread source has null workspacePath when thread is null', () => {
  const vm = buildRunInspectionViewModel([], [], null, 0)

  const thread = vm.contextSources.find((s) => s.kind === 'thread')
  assert.ok(thread && thread.kind === 'thread')
  assert.equal(thread.workspacePath, null)
})

// ---- Run selection ----

test('buildRunInspectionViewModel picks the latest run when multiple runs exist', () => {
  const older = { ...BASE_RUN, id: 'run-1', createdAt: '2026-03-17T00:00:00.000Z' }
  const newer = { ...BASE_RUN, id: 'run-2', createdAt: '2026-03-17T00:01:00.000Z' }

  const vm = buildRunInspectionViewModel([older, newer], [], null, 0)

  assert.equal(vm.run?.id, 'run-2')
})

// ---- Tool call filtering / sorting ----

test('buildRunInspectionViewModel only returns tool calls belonging to the latest run', () => {
  const older = { ...BASE_RUN, id: 'run-1', createdAt: '2026-03-17T00:00:00.000Z' }
  const newer = { ...BASE_RUN, id: 'run-2', createdAt: '2026-03-17T00:01:00.000Z' }

  const toolForOlder = { ...BASE_TOOL_CALL, id: 'tool-a', runId: 'run-1' }
  const toolForNewer = { ...BASE_TOOL_CALL, id: 'tool-b', runId: 'run-2' }

  const vm = buildRunInspectionViewModel([older, newer], [toolForOlder, toolForNewer], null, 0)

  assert.equal(vm.toolCalls.length, 1)
  assert.equal(vm.toolCalls[0].id, 'tool-b')
})

test('buildRunInspectionViewModel sorts tool calls by startedAt ascending', () => {
  const tool1 = { ...BASE_TOOL_CALL, id: 'tool-1', startedAt: '2026-03-17T00:00:03.000Z' }
  const tool2 = { ...BASE_TOOL_CALL, id: 'tool-2', startedAt: '2026-03-17T00:00:01.000Z' }

  const vm = buildRunInspectionViewModel([BASE_RUN], [tool1, tool2], null, 0)

  assert.equal(vm.toolCalls[0].id, 'tool-2')
  assert.equal(vm.toolCalls[1].id, 'tool-1')
})

// ---- Context sources from run record ----

test('buildRunInspectionViewModel prepends thread source before server-populated sources', () => {
  const runWithSources = {
    ...BASE_RUN,
    contextSources: [
      { kind: 'persona' as const, present: true },
      { kind: 'memory' as const, present: false, summary: 'not recalled' }
    ]
  }

  const vm = buildRunInspectionViewModel([runWithSources], [], null, 8)

  assert.equal(vm.contextSources[0].kind, 'thread')
  assert.equal(vm.contextSources[1].kind, 'persona')
  assert.equal(vm.contextSources[2].kind, 'memory')
})

test('buildRunInspectionViewModel uses empty sources list when contextSources absent', () => {
  const vm = buildRunInspectionViewModel([BASE_RUN], [], null, 0)

  // Only thread source — server hasn't populated contextSources yet
  assert.equal(vm.contextSources.length, 1)
  assert.equal(vm.contextSources[0].kind, 'thread')
})

test('buildRunInspectionViewModel passes through server-populated source metadata', () => {
  const runWithSources = {
    ...BASE_RUN,
    contextSources: [
      { kind: 'soul' as const, present: true, count: 3, summary: '3 traits' },
      { kind: 'agent' as const, present: true, count: 4, summary: '4 tools · workspace' },
      {
        kind: 'memory' as const,
        present: true,
        count: 2,
        reasons: ['new thread'],
        summary: '2 memories recalled'
      }
    ]
  }

  const vm = buildRunInspectionViewModel([runWithSources], [], null, 0)

  const soul = vm.contextSources.find((s) => s.kind === 'soul')
  assert.ok(soul && soul.kind === 'soul')
  assert.equal(soul.present, true)
  assert.equal(soul.count, 3)

  const memory = vm.contextSources.find((s) => s.kind === 'memory')
  assert.ok(memory && memory.kind === 'memory')
  assert.equal(memory.present, true)
  assert.deepEqual(memory.reasons, ['new thread'])
})
