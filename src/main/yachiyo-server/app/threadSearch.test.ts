import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { runYachiyoCli } from './yachiyo-cli.ts'
import { enrichSkillsReadDetails, parseToolCallDetails } from './threadSearch.ts'
import type {
  MessageSearchHit,
  ThreadDump,
  ThreadDumpToolCall,
  ThreadSummary
} from './threadSearch.ts'

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

  it('defaults includePrivate to false for searchMessages', async () => {
    let capturedIncludePrivate = true
    await runYachiyoCli(['thread', 'search', 'q'], {
      searchMessages: (_dbPath, _query, _limit, includePrivate) => {
        capturedIncludePrivate = includePrivate
        return []
      },
      stdout: captureOutput([])
    })
    assert.equal(capturedIncludePrivate, false)
  })

  it('passes includePrivate=true to searchMessages with --include-private', async () => {
    let capturedIncludePrivate = false
    await runYachiyoCli(['thread', 'search', 'q', '--include-private'], {
      searchMessages: (_dbPath, _query, _limit, includePrivate) => {
        capturedIncludePrivate = includePrivate
        return []
      },
      stdout: captureOutput([])
    })
    assert.equal(capturedIncludePrivate, true)
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
    selfReviewedAt: null,
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

  it('defaults includePrivate to false for listRecentThreads', async () => {
    let capturedIncludePrivate = true
    await runYachiyoCli(['thread', 'list'], {
      listRecentThreads: (_db, _limit, includePrivate) => {
        capturedIncludePrivate = includePrivate
        return []
      },
      stdout: captureOutput([])
    })
    assert.equal(capturedIncludePrivate, false)
  })

  it('passes includePrivate=true to listRecentThreads with --include-private', async () => {
    let capturedIncludePrivate = false
    await runYachiyoCli(['thread', 'list', '--include-private'], {
      listRecentThreads: (_db, _limit, includePrivate) => {
        capturedIncludePrivate = includePrivate
        return []
      },
      stdout: captureOutput([])
    })
    assert.equal(capturedIncludePrivate, true)
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

  it('shows [reviewed] tag for self-reviewed threads', async () => {
    const out: string[] = []
    await runYachiyoCli(['thread', 'list'], {
      listRecentThreads: () => [
        makeSummary({ selfReviewedAt: '2026-04-08T03:00:00Z' }),
        makeSummary({ threadId: 'thread-b', selfReviewedAt: null })
      ],
      stdout: captureOutput(out)
    })
    const text = out.join('')
    assert.ok(text.includes('[reviewed] Planning session'))
    assert.ok(
      !text.includes('[thread-b]') ||
        !text.includes('[thread-b]') ||
        text.split('[reviewed]').length === 2
    )
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
    toolCalls: [],
    ...overrides
  }
}

function makeToolCall(overrides: Partial<ThreadDumpToolCall> = {}): ThreadDumpToolCall {
  return {
    id: 'call-1',
    runId: 'run-1',
    toolName: 'skillsRead',
    status: 'completed',
    inputSummary: 'names=["release-process"]',
    outputSummary: 'Skill: release-process',
    error: null,
    details: { requestedNames: ['release-process'], resolvedCount: 1, skills: [] },
    startedAt: '2026-04-05T08:00:03.000Z',
    finishedAt: '2026-04-05T08:00:04.000Z',
    stepIndex: 1,
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

  it('defaults includePrivate to false for dumpThread', async () => {
    let capturedIncludePrivate = true
    await runYachiyoCli(['thread', 'show', 'target-id'], {
      dumpThread: (_db, _id, includePrivate) => {
        capturedIncludePrivate = includePrivate
        return makeDump({ threadId: 'target-id' })
      },
      stdout: captureOutput([])
    })
    assert.equal(capturedIncludePrivate, false)
  })

  it('passes includePrivate=true to dumpThread with --include-private', async () => {
    let capturedIncludePrivate = false
    await runYachiyoCli(['thread', 'show', 'target-id', '--include-private'], {
      dumpThread: (_db, _id, includePrivate) => {
        capturedIncludePrivate = includePrivate
        return makeDump({ threadId: 'target-id' })
      },
      stdout: captureOutput([])
    })
    assert.equal(capturedIncludePrivate, true)
  })

  it('shows "Tool calls: 0" in header when no tool calls', async () => {
    const out: string[] = []
    await runYachiyoCli(['thread', 'show', 'thread-a'], {
      dumpThread: () => makeDump(),
      stdout: captureOutput(out)
    })
    const text = out.join('')
    assert.ok(text.includes('Tool calls: 0'))
    assert.ok(!text.includes('── tool calls ──'))
  })

  it('renders a tool calls section in text output when present', async () => {
    const out: string[] = []
    await runYachiyoCli(['thread', 'show', 'thread-a'], {
      dumpThread: () =>
        makeDump({
          toolCalls: [
            makeToolCall({
              toolName: 'skillsRead',
              status: 'completed',
              inputSummary: 'names=["release-process"]',
              stepIndex: 1
            }),
            makeToolCall({
              id: 'call-2',
              toolName: 'read',
              status: 'failed',
              inputSummary: 'path=/tmp/missing.txt',
              error: 'ENOENT: no such file',
              stepIndex: 2,
              startedAt: '2026-04-05T08:00:10.000Z',
              finishedAt: '2026-04-05T08:00:10.500Z'
            })
          ]
        }),
      stdout: captureOutput(out)
    })
    const text = out.join('')
    assert.ok(text.includes('Tool calls: 2'))
    assert.ok(text.includes('── tool calls ──'))
    assert.ok(text.includes('#1 skillsRead [completed] names=["release-process"]'))
    assert.ok(text.includes('#2 read [failed] path=/tmp/missing.txt  ERROR: ENOENT: no such file'))
  })

  it('includes tool calls in --json output verbatim', async () => {
    const dump = makeDump({
      toolCalls: [
        makeToolCall({
          details: { requestedNames: ['release-process'], resolvedCount: 1, skills: [] }
        })
      ]
    })
    const out: string[] = []
    await runYachiyoCli(['thread', 'show', 'thread-a', '--json'], {
      dumpThread: () => dump,
      stdout: captureOutput(out)
    })
    const parsed = JSON.parse(out.join('')) as ThreadDump
    assert.equal(parsed.toolCalls.length, 1)
    assert.equal(parsed.toolCalls[0]?.toolName, 'skillsRead')
    assert.deepEqual(parsed.toolCalls[0]?.details, {
      requestedNames: ['release-process'],
      resolvedCount: 1,
      skills: []
    })
  })
})

describe('parseToolCallDetails', () => {
  it('parses valid JSON into a structured object', () => {
    const parsed = parseToolCallDetails('{"requestedNames":["a","b"],"resolvedCount":2}')
    assert.deepEqual(parsed, { requestedNames: ['a', 'b'], resolvedCount: 2 })
  })

  it('returns the raw string for non-JSON input', () => {
    assert.equal(parseToolCallDetails('just a plain string'), 'just a plain string')
  })

  it('returns null for null, undefined, or empty input', () => {
    assert.equal(parseToolCallDetails(null), null)
    assert.equal(parseToolCallDetails(undefined), null)
    assert.equal(parseToolCallDetails(''), null)
  })

  it('parses a JSON array payload', () => {
    assert.deepEqual(parseToolCallDetails('[1,2,3]'), [1, 2, 3])
  })
})

describe('enrichSkillsReadDetails', () => {
  const HOME_SKILLS = '/Users/ringo/.yachiyo/skills'

  it('tags each resolved skill with origin="bundled" or "writable"', () => {
    const parsed = {
      requestedNames: ['core-doctor', 'note-taker'],
      resolvedCount: 2,
      skills: [
        {
          name: 'core-doctor',
          directoryPath: '/Users/ringo/.yachiyo/skills/core/core-doctor',
          description: 'Bundled'
        },
        {
          name: 'note-taker',
          directoryPath: '/Users/ringo/.yachiyo/skills/custom/note-taker',
          description: 'Custom'
        }
      ]
    }
    const enriched = enrichSkillsReadDetails(parsed, HOME_SKILLS) as {
      skills: Array<{ name: string; origin: string }>
    }
    assert.equal(enriched.skills[0]?.origin, 'bundled')
    assert.equal(enriched.skills[1]?.origin, 'writable')
  })

  it('handles Windows-style directory paths (backslashes)', () => {
    const parsed = {
      skills: [
        {
          name: 'core-doctor',
          directoryPath: 'C:\\Users\\ringo\\.yachiyo\\skills\\core\\core-doctor'
        }
      ]
    }
    const enriched = enrichSkillsReadDetails(parsed, 'C:\\Users\\ringo\\.yachiyo\\skills') as {
      skills: Array<{ origin: string }>
    }
    assert.equal(
      enriched.skills[0]?.origin,
      'bundled',
      'Windows-style core path should be detected as bundled'
    )
  })

  it('does NOT label a workspace-local .yachiyo/skills/core skill as bundled', () => {
    // Regression test for the P2 false-positive: a repo can have its own
    // .yachiyo/skills/core/ directory; that path contains the substring
    // `/.yachiyo/skills/core/` but is NOT under the Yachiyo home dir, so it
    // must stay writable and refinable.
    const parsed = {
      skills: [
        {
          name: 'repo-core',
          directoryPath: '/tmp/myrepo/.yachiyo/skills/core/repo-core'
        }
      ]
    }
    const enriched = enrichSkillsReadDetails(parsed, HOME_SKILLS) as {
      skills: Array<{ origin: string }>
    }
    assert.equal(
      enriched.skills[0]?.origin,
      'writable',
      'Workspace .yachiyo/skills/core/ must stay writable'
    )
  })

  it('passes frozen origin through verbatim without recomputing against current home', () => {
    // Regression guard for the review P2: if origin is already stored on
    // the row, enrichSkillsReadDetails must NOT recompute it — the stored
    // value is frozen from the time the tool was invoked, and the current
    // resolveYachiyoDataDir() may point somewhere else entirely.
    const parsed = {
      skills: [
        {
          name: 'old-custom',
          // This path looks like it lives under a DIFFERENT Yachiyo home
          // than HOME_SKILLS, but was explicitly stored as "custom" at
          // write time. We must trust the stored value.
          directoryPath: '/some/other/home/.yachiyo/skills/core/old-custom',
          origin: 'custom'
        },
        {
          name: 'old-bundled',
          // Similarly, a skill stored as bundled from a different home
          // must stay bundled, even though its path doesn't match the
          // current home's core dir at all.
          directoryPath: '/some/other/home/.yachiyo/skills/core/old-bundled',
          origin: 'bundled'
        }
      ]
    }
    const enriched = enrichSkillsReadDetails(parsed, HOME_SKILLS) as {
      skills: Array<{ origin: string }>
    }
    assert.equal(
      enriched.skills[0]?.origin,
      'custom',
      'Frozen custom origin must not be recomputed to bundled/writable'
    )
    assert.equal(
      enriched.skills[1]?.origin,
      'bundled',
      'Frozen bundled origin must survive even when path is outside current home'
    )
  })

  it('falls back to path-based computation only when origin is missing', () => {
    // Legacy rows written before the origin-freeze change have no origin
    // field; the enrichment must compute it as a best-effort default.
    const parsed = {
      skills: [
        {
          name: 'legacy-custom',
          directoryPath: '/Users/ringo/.yachiyo/skills/custom/legacy'
          // no origin field — legacy row
        },
        {
          name: 'legacy-bundled',
          directoryPath: '/Users/ringo/.yachiyo/skills/core/legacy'
          // no origin field — legacy row
        }
      ]
    }
    const enriched = enrichSkillsReadDetails(parsed, HOME_SKILLS) as {
      skills: Array<{ origin: string }>
    }
    assert.equal(enriched.skills[0]?.origin, 'writable')
    assert.equal(enriched.skills[1]?.origin, 'bundled')
  })

  it('leaves non-skill entries untouched and preserves other fields', () => {
    const parsed = {
      requestedNames: ['anything'],
      resolvedCount: 0,
      skills: [],
      missingNames: ['anything']
    }
    const enriched = enrichSkillsReadDetails(parsed, HOME_SKILLS) as typeof parsed
    assert.deepEqual(enriched.missingNames, ['anything'])
    assert.deepEqual(enriched.requestedNames, ['anything'])
    assert.deepEqual(enriched.skills, [])
  })

  it('passes through non-object inputs unchanged', () => {
    assert.equal(enrichSkillsReadDetails(null, HOME_SKILLS), null)
    assert.equal(enrichSkillsReadDetails('a raw string', HOME_SKILLS), 'a raw string')
    assert.deepEqual(enrichSkillsReadDetails([1, 2, 3], HOME_SKILLS), [1, 2, 3])
  })

  it('tolerates malformed skill entries without throwing', () => {
    const parsed = {
      skills: [
        null,
        'not an object',
        { name: 'missing-path' }, // no directoryPath
        { name: 'bad-path-type', directoryPath: 42 }, // wrong type
        {
          name: 'ok',
          directoryPath: '/Users/ringo/.yachiyo/skills/custom/ok'
        }
      ]
    }
    const enriched = enrichSkillsReadDetails(parsed, HOME_SKILLS) as { skills: unknown[] }
    assert.equal(enriched.skills.length, 5)
    // The valid one is enriched
    const last = enriched.skills[4] as { origin?: string }
    assert.equal(last.origin, 'writable')
    // Invalid ones are passed through untouched
    assert.equal(enriched.skills[0], null)
    assert.equal(enriched.skills[1], 'not an object')
  })
})
