import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { runYachiyoCli } from './yachiyo-cli.ts'
import type { MessageSearchHit } from './threadSearch.ts'

function makeHit(overrides: Partial<MessageSearchHit> = {}): MessageSearchHit {
  return {
    threadId: 'thread-1',
    threadTitle: 'My Thread',
    messageId: 'msg-1',
    role: 'user',
    date: '2024-03-15',
    snippet: 'hello world',
    ...overrides
  }
}

function captureOutput(writes: string[]): Pick<typeof process.stdout, 'write'> {
  return {
    write: (chunk: string) => {
      writes.push(chunk)
      return true
    }
  }
}

describe('thread search command', () => {
  it('outputs plain text results by default', async () => {
    const hits = [
      makeHit({ threadId: 'abc', role: 'user', date: '2024-01-01', snippet: 'found it' })
    ]
    const out: string[] = []
    await runYachiyoCli(['thread', 'search', 'found'], {
      searchMessages: () => hits,
      stdout: captureOutput(out)
    })
    assert.ok(out.join('').includes('[ThreadID: abc]'))
    assert.ok(out.join('').includes('Role: user'))
    assert.ok(out.join('').includes('Content: found it'))
  })

  it('maps assistant role to "model" in plain text', async () => {
    const hits = [makeHit({ role: 'assistant' })]
    const out: string[] = []
    await runYachiyoCli(['thread', 'search', 'q'], {
      searchMessages: () => hits,
      stdout: captureOutput(out)
    })
    assert.ok(out.join('').includes('Role: model'))
    assert.ok(!out.join('').includes('Role: assistant'))
  })

  it('outputs JSON array with --json flag', async () => {
    const hits = [makeHit()]
    const out: string[] = []
    await runYachiyoCli(['thread', 'search', 'q', '--json'], {
      searchMessages: () => hits,
      stdout: captureOutput(out)
    })
    const parsed = JSON.parse(out.join(''))
    assert.deepEqual(parsed, hits)
  })

  it('passes limit to searchMessages', async () => {
    let capturedLimit = 0
    await runYachiyoCli(['thread', 'search', 'q', '--limit', '10'], {
      searchMessages: (_dbPath, _query, limit) => {
        capturedLimit = limit
        return []
      },
      stdout: captureOutput([])
    })
    assert.equal(capturedLimit, 10)
  })

  it('defaults limit to 5', async () => {
    let capturedLimit = 0
    await runYachiyoCli(['thread', 'search', 'q'], {
      searchMessages: (_dbPath, _query, limit) => {
        capturedLimit = limit
        return []
      },
      stdout: captureOutput([])
    })
    assert.equal(capturedLimit, 5)
  })

  it('passes query to searchMessages', async () => {
    let capturedQuery = ''
    await runYachiyoCli(['thread', 'search', 'my query'], {
      searchMessages: (_dbPath, query) => {
        capturedQuery = query
        return []
      },
      stdout: captureOutput([])
    })
    assert.equal(capturedQuery, 'my query')
  })

  it('throws when query is missing', async () => {
    await assert.rejects(
      () =>
        runYachiyoCli(['thread', 'search'], {
          searchMessages: () => [],
          stdout: captureOutput([])
        }),
      /Query is required/
    )
  })

  it('throws on unknown thread subcommand', async () => {
    await assert.rejects(
      () =>
        runYachiyoCli(['thread', 'unknown'], {
          searchMessages: () => [],
          stdout: captureOutput([])
        }),
      /Unknown thread action/
    )
  })

  it('throws on invalid --limit', async () => {
    await assert.rejects(
      () =>
        runYachiyoCli(['thread', 'search', 'q', '--limit', 'abc'], {
          searchMessages: () => [],
          stdout: captureOutput([])
        }),
      /--limit must be a positive integer/
    )
  })

  it('outputs (no results) message when empty', async () => {
    const out: string[] = []
    await runYachiyoCli(['thread', 'search', 'nope'], {
      searchMessages: () => [],
      stdout: captureOutput(out)
    })
    assert.ok(out.join('').includes('(no results)'))
  })
})
