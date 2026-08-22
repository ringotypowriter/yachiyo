import assert from 'node:assert/strict'
import test from 'node:test'

import type { PreparedServerRunContext } from '../context/prepareServerRunContext.ts'
import type { RunExecutionDeps } from './runExecutionTypes.ts'
import { createRunToolSet, type CreateRunToolSetInput } from './runToolSetFactory.ts'

function createToolSet(flags: {
  isLocalRunTrigger: boolean
  isOwnerDm: boolean
  isExternalChannel: boolean
  modelEnabledTools?: string[]
  sentinelContext?: RunExecutionDeps['sentinelContext']
}): ReturnType<typeof createRunToolSet> {
  const preparedContext = {
    availableSkills: [],
    activeSkills: [],
    enabledSubagentProfiles: [],
    subagentsConfig: { mode: 'worker', enabledNamedAgents: ['general'] },
    gitCtx: { hasGit: false },
    gitValidatedWorkspaces: [],
    subagentAvailableWorkspaces: ['/workspace'],
    isGuest: flags.isExternalChannel && !flags.isOwnerDm,
    isDirectMessage: flags.isExternalChannel,
    isExternalChannel: flags.isExternalChannel,
    isLocalRunTrigger: flags.isLocalRunTrigger,
    isOwnerDm: flags.isOwnerDm,
    modelEnabledTools: flags.modelEnabledTools ?? ['delegateTask'],
    workspacePath: '/workspace',
    config: {},
    runMode: 'auto'
  } as unknown as PreparedServerRunContext
  const deps = {
    createModelRuntime: () => ({}) as never,
    readSettings: () => ({}) as never,
    memoryService: { isConfigured: () => false },
    subagentManager: {},
    sentinelContext: flags.sentinelContext,
    parentDeliveryContext: {
      enabledTools: ['delegateTask'],
      runMode: 'auto',
      runTrigger: flags.isLocalRunTrigger ? 'local' : 'channel'
    }
  } as unknown as RunExecutionDeps
  const input = {
    advanceAgentStep: () => 0,
    createToolCall: () => {},
    deps,
    executionInput: {
      runId: 'run-1',
      thread: { id: 'thread-1', privacyMode: false }
    },
    markProgress: () => {},
    maxToolSteps: 4,
    pendingUserAnswers: new Map(),
    persistRecoveryCheckpoint: () => {},
    preparedContext,
    setExecutionPhase: () => {},
    snapshotTracker: {},
    subagentStartedAtByDelegationId: new Map(),
    toolLifecycle: {},
    updateToolCall: () => {}
  } as unknown as CreateRunToolSetInput

  return createRunToolSet(input)
}

test('Worker delegation is available on Local threads and Owner DMs', () => {
  assert.equal(
    Boolean(
      createToolSet({ isLocalRunTrigger: true, isOwnerDm: false, isExternalChannel: false })
        ?.delegateTask
    ),
    true
  )
  assert.equal(
    Boolean(
      createToolSet({ isLocalRunTrigger: false, isOwnerDm: true, isExternalChannel: true })
        ?.delegateTask
    ),
    true
  )
})

test('Worker delegation is absent on Group and Guest DM channels', () => {
  assert.equal(
    Boolean(
      createToolSet({ isLocalRunTrigger: false, isOwnerDm: false, isExternalChannel: true })
        ?.delegateTask
    ),
    false
  )
})

test('useSentinel is available when enabled with a sentinel context', () => {
  const tools = createToolSet({
    isLocalRunTrigger: false,
    isOwnerDm: false,
    isExternalChannel: false,
    modelEnabledTools: ['useSentinel'],
    sentinelContext: {
      threadId: 'thread-1',
      manager: {
        set: () => {
          throw new Error('not called')
        },
        clear: () => false,
        get: () => undefined,
        list: () => [],
        onRunTerminal: () => {},
        dispose: () => {}
      }
    }
  })

  assert.equal(typeof tools?.useSentinel?.execute, 'function')
})
