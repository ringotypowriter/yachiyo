import assert from 'node:assert/strict'
import test from 'node:test'

import type { SettingsConfig } from '../../../../shared/yachiyo/protocol.ts'
import { createNowledgeMemProvider } from './nowledgeMemProvider.ts'

const BASE_CONFIG: SettingsConfig = {
  providers: [],
  memory: {
    enabled: true,
    provider: 'nowledge-mem',
    baseUrl: 'http://127.0.0.1:14242'
  }
}

test('Nowledge Mem provider searches memories through the nmem CLI and preserves topic metadata', async () => {
  const calls: Array<{ args: string[]; env?: NodeJS.ProcessEnv }> = []
  const provider = createNowledgeMemProvider(BASE_CONFIG, {
    runCommand: async (input) => {
      calls.push({
        args: input.args,
        env: input.env
      })

      return {
        exitCode: 0,
        stderr: '',
        stdout: JSON.stringify({
          query: 'repo root preference',
          total: 1,
          memories: [
            {
              id: 'mem-1',
              title: 'Repo preference',
              content: 'Use the yachiyo root when working on this app.',
              score: 0.91,
              source_thread: 'thread-1',
              labels: ['topic:repo-preference'],
              unit_type: 'preference',
              importance: 0.7
            }
          ]
        })
      }
    }
  })

  const results = await provider.searchMemories({
    limit: 3,
    query: 'repo root preference',
    label: 'topic:repo-preference'
  })

  assert.deepEqual(calls[0]?.args, [
    'm',
    'search',
    '--limit',
    '3',
    '--label',
    'topic:repo-preference',
    'repo root preference'
  ])
  assert.equal(calls[0]?.env?.NMEM_API_URL, 'http://127.0.0.1:14242')
  assert.deepEqual(results, [
    {
      id: 'mem-1',
      title: 'Repo preference',
      content: 'Use the yachiyo root when working on this app.',
      score: 0.91,
      sourceThreadId: 'thread-1',
      labels: ['topic:repo-preference'],
      unitType: 'preference',
      importance: 0.7
    }
  ])
})

test('Nowledge Mem provider creates memories through the nmem CLI with Yachiyo topic metadata', async () => {
  const calls: Array<{ args: string[]; env?: NodeJS.ProcessEnv }> = []
  const provider = createNowledgeMemProvider(BASE_CONFIG, {
    runCommand: async (input) => {
      calls.push({
        args: input.args,
        env: input.env
      })

      return {
        exitCode: 0,
        stderr: '',
        stdout: JSON.stringify({ success: true, id: `mem-${calls.length}` })
      }
    }
  })

  const saved = await provider.createMemories({
    items: [
      {
        topic: 'team-package-manager',
        title: 'Package manager preference',
        content: 'Prefer pnpm for this repository.',
        unitType: 'preference'
      },
      {
        topic: 'testing-workflow',
        title: 'Testing workflow',
        content: 'Run server tests before shipping memory changes.',
        unitType: 'procedure',
        importance: 0.8
      }
    ]
  })

  assert.equal(saved.savedCount, 2)
  assert.deepEqual(calls[0]?.args, [
    'm',
    'add',
    '--title',
    'Package manager preference',
    '--source',
    'Yachiyo',
    '--label',
    'topic:team-package-manager',
    '--unit-type',
    'preference',
    'Prefer pnpm for this repository.'
  ])
  assert.deepEqual(calls[1]?.args, [
    'm',
    'add',
    '--title',
    'Testing workflow',
    '--source',
    'Yachiyo',
    '--label',
    'topic:testing-workflow',
    '--unit-type',
    'procedure',
    '--importance',
    '0.8',
    'Run server tests before shipping memory changes.'
  ])
  assert.equal(calls[1]?.env?.NMEM_API_URL, 'http://127.0.0.1:14242')
})

test('Nowledge Mem provider updates an existing memory through the nmem CLI', async () => {
  const calls: Array<{ args: string[]; env?: NodeJS.ProcessEnv }> = []
  const provider = createNowledgeMemProvider(BASE_CONFIG, {
    runCommand: async (input) => {
      calls.push({
        args: input.args,
        env: input.env
      })

      return {
        exitCode: 0,
        stderr: '',
        stdout: JSON.stringify({ success: true, id: 'mem-1' })
      }
    }
  })

  await provider.updateMemory({
    id: 'mem-1',
    item: {
      topic: 'repo-preference',
      title: 'Repo preference',
      content: 'Use the Yachiyo repo root for commands and work from that root.',
      unitType: 'preference',
      importance: 0.8
    }
  })

  assert.deepEqual(calls[0]?.args, [
    'm',
    'update',
    'mem-1',
    '--title',
    'Repo preference',
    '--content',
    'Use the Yachiyo repo root for commands and work from that root.',
    '--importance',
    '0.8'
  ])
})

test('Nowledge Mem provider surfaces CLI failures', async () => {
  const provider = createNowledgeMemProvider(BASE_CONFIG, {
    runCommand: async () => ({
      exitCode: 1,
      stderr: '',
      stdout: JSON.stringify({
        error: 'connection_failed',
        message: 'Cannot connect to http://127.0.0.1:14242'
      })
    })
  })

  await assert.rejects(
    () =>
      provider.searchMemories({
        limit: 3,
        query: 'repo root preference'
      }),
    /Cannot connect to http:\/\/127\.0\.0\.1:14242/
  )
})
