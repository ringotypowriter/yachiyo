import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { runYachiyoCli } from './yachiyo-cli.ts'
import type { MessageSearchHit, ThreadDump, ThreadSummary } from './threadSearch.ts'

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

function makeSummary(overrides: Partial<ThreadSummary> = {}): ThreadSummary {
  return {
    threadId: 'thread-a',
    title: 'Planning session',
    preview: 'discuss Q2 roadmap',
    firstUserQuery: 'how do we plan Q2?',
    messageCount: 12,
    updatedAt: '2026-04-07T10:15:30.000Z',
    createdAt: '2026-04-05T08:00:00.000Z',
    ...overrides
  }
}

describe('thread list command', () => {
  it('prints compact text by default with first user query', async () => {
    const out: string[] = []
    await runYachiyoCli(['thread', 'list'], {
      listRecentThreads: () => [makeSummary()],
      stdout: captureOutput(out)
    })
    const text = out.join('')
    assert.ok(text.includes('[thread-a]'))
    assert.ok(text.includes('Planning session'))
    assert.ok(text.includes('(12 msgs)'))
    assert.ok(text.includes('q: how do we plan Q2?'))
  })

  it('defaults limit to 10 and passes --limit through', async () => {
    let defaulted = 0
    await runYachiyoCli(['thread', 'list'], {
      listRecentThreads: (_db, limit) => {
        defaulted = limit
        return []
      },
      stdout: captureOutput([])
    })
    assert.equal(defaulted, 10)

    let overridden = 0
    await runYachiyoCli(['thread', 'list', '--limit', '3'], {
      listRecentThreads: (_db, limit) => {
        overridden = limit
        return []
      },
      stdout: captureOutput([])
    })
    assert.equal(overridden, 3)
  })

  it('emits JSON array with --json', async () => {
    const summaries = [makeSummary(), makeSummary({ threadId: 'thread-b' })]
    const out: string[] = []
    await runYachiyoCli(['thread', 'list', '--json'], {
      listRecentThreads: () => summaries,
      stdout: captureOutput(out)
    })
    assert.deepEqual(JSON.parse(out.join('')), summaries)
  })

  it('prints (no threads) when empty', async () => {
    const out: string[] = []
    await runYachiyoCli(['thread', 'list'], {
      listRecentThreads: () => [],
      stdout: captureOutput(out)
    })
    assert.ok(out.join('').includes('(no threads)'))
  })
})

function makeDump(overrides: Partial<ThreadDump> = {}): ThreadDump {
  return {
    threadId: 'thread-a',
    title: 'Planning session',
    preview: null,
    updatedAt: '2026-04-07T10:15:30.000Z',
    createdAt: '2026-04-05T08:00:00.000Z',
    messages: [
      {
        messageId: 'm1',
        role: 'user',
        createdAt: '2026-04-05T08:00:00.000Z',
        content: 'hello'
      },
      {
        messageId: 'm2',
        role: 'assistant',
        createdAt: '2026-04-05T08:00:05.000Z',
        content: 'hi there'
      }
    ],
    ...overrides
  }
}

describe('thread show command', () => {
  it('requires a thread id', async () => {
    await assert.rejects(
      () =>
        runYachiyoCli(['thread', 'show'], {
          dumpThread: () => null,
          stdout: captureOutput([])
        }),
      /Thread id is required/
    )
  })

  it('throws when thread is not found', async () => {
    await assert.rejects(
      () =>
        runYachiyoCli(['thread', 'show', 'missing'], {
          dumpThread: () => null,
          stdout: captureOutput([])
        }),
      /Thread not found: missing/
    )
  })

  it('prints dump text with both roles in order', async () => {
    const out: string[] = []
    await runYachiyoCli(['thread', 'show', 'thread-a'], {
      dumpThread: () => makeDump(),
      stdout: captureOutput(out)
    })
    const text = out.join('')
    assert.ok(text.includes('Thread thread-a: Planning session'))
    assert.ok(text.includes('Messages: 2'))
    assert.ok(text.includes('── user @'))
    assert.ok(text.includes('── model @'))
    assert.ok(text.indexOf('hello') < text.indexOf('hi there'))
  })

  it('emits JSON dump with --json', async () => {
    const dump = makeDump()
    const out: string[] = []
    await runYachiyoCli(['thread', 'show', 'thread-a', '--json'], {
      dumpThread: () => dump,
      stdout: captureOutput(out)
    })
    assert.deepEqual(JSON.parse(out.join('')), dump)
  })

  it('passes threadId to dumpThread', async () => {
    let captured = ''
    await runYachiyoCli(['thread', 'show', 'target-id', '--json'], {
      dumpThread: (_db, id) => {
        captured = id
        return makeDump({ threadId: 'target-id' })
      },
      stdout: captureOutput([])
    })
    assert.equal(captured, 'target-id')
  })
})
