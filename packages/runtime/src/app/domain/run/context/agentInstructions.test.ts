import assert from 'node:assert/strict'
import test from 'node:test'
import { buildAgentInstructions, buildSubagentContextBlock } from './agentInstructions.ts'

test('minimal runtime retains environment and project constraints without the operating guide', () => {
  const project = buildSubagentContextBlock(
    {
      hasGit: true,
      currentBranch: 'main',
      mainBranch: 'main',
      hasAgentsMd: true,
      agentsMdContent: 'Project constraint'
    },
    '/tmp/project',
    [],
    ['/tmp/project'],
    { mode: 'worker', enabledNamedAgents: ['explore'] },
    [],
    true
  )
  const result = buildAgentInstructions({
    workspacePath: '/tmp/project',
    enabledTools: ['read'],
    activeSkills: [],
    hasSourceQuery: false,
    minimalPrompt: true,
    runMode: 'explore',
    soulDocumentPath: '/tmp/SOUL.md',
    userDocumentPath: '/tmp/USER.md',
    subagentContextBlock: project
  })
  for (const fact of [
    '/tmp/project',
    'explore',
    '/tmp/SOUL.md',
    '/tmp/USER.md',
    'Project constraint'
  ]) {
    assert.ok(result.includes(fact))
  }
  assert.ok(!result.includes('Available run modes:'))
  assert.ok(!result.includes('Worker collaboration:'))
  assert.ok(!result.includes('already loaded above'))
})
