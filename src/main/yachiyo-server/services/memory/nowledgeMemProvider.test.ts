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

test('Nowledge Mem provider searches memories through the nmem CLI', async () => {
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
              source_thread: 'thread-1'
            }
          ]
        })
      }
    }
  })

  const results = await provider.searchMemories({
    limit: 3,
    query: 'repo root preference'
  })

  assert.deepEqual(calls[0]?.args, ['m', 'search', '--limit', '3', 'repo root preference'])
  assert.equal(calls[0]?.env?.NMEM_API_URL, 'http://127.0.0.1:14242')
  assert.deepEqual(results, [
    {
      id: 'mem-1',
      title: 'Repo preference',
      content: 'Use the yachiyo root when working on this app.',
      score: 0.91,
      sourceThreadId: 'thread-1'
    }
  ])
})

test('Nowledge Mem provider creates one memory per distilled candidate through the nmem CLI', async () => {
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
        title: 'Team preference',
        content: 'Prefer pnpm for this repository.'
      },
      {
        title: 'Workflow',
        content: 'Run server tests before shipping memory changes.',
        importance: 0.8
      }
    ]
  })

  assert.equal(saved.savedCount, 2)
  assert.deepEqual(calls[0]?.args, [
    'm',
    'add',
    '--title',
    'Team preference',
    '--source',
    'Yachiyo',
    'Prefer pnpm for this repository.'
  ])
  assert.deepEqual(calls[1]?.args, [
    'm',
    'add',
    '--title',
    'Workflow',
    '--source',
    'Yachiyo',
    '--importance',
    '0.8',
    'Run server tests before shipping memory changes.'
  ])
  assert.equal(calls[1]?.env?.NMEM_API_URL, 'http://127.0.0.1:14242')
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
