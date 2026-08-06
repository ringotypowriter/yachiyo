import assert from 'node:assert/strict'

import type { YachiyoStorage } from './storage.ts'

/**
 * The paging contract, written once and run against every storage.
 *
 * The two implementations had drifted twice before this existed — the
 * in-memory store ignored paging options entirely, and later the two
 * disagreed about whether an illegal limit is refused when it arrives
 * alongside a cursor that misses. Both times the alignment was maintained by
 * eye, in two files, and both times the eye lost.
 *
 * So the assertions live here and both stores run them: the in-memory store in
 * the normal Node suite, sqlite in `.native.test.ts` under Electron. Only one
 * of those gates CI, but a divergence now fails somewhere rather than nowhere.
 */

/** `message-04` and `message-05` deliberately share a timestamp. */
const SHARED_TIMESTAMP = '2026-03-20T00:00:04.000Z'

function messageId(index: number): string {
  // Zero-padded so lexicographic id order matches numeric order — the tie-break
  // sorts by id, and `message-10` sorts before `message-2` without the padding.
  return `message-${String(index).padStart(2, '0')}`
}

function ids(messages: { id: string }[]): string[] {
  return messages.map((message) => message.id)
}

/**
 * Seed the two threads the contract expects.
 *
 * Thread 1 holds ten messages of which two share a timestamp, positioned so
 * that a page boundary falls between them: with `limit: 3`, the third page
 * ends exactly on the tie. A cursor comparing timestamps alone drops the
 * message on the far side of that tie, and it is never seen again.
 */
export function seedThreadMessagePagingFixture(storage: YachiyoStorage): void {
  const messages = Array.from({ length: 10 }, (_, index) => ({
    id: messageId(index + 1),
    threadId: 'thread-1',
    role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
    content: `Message ${index + 1}`,
    status: 'completed' as const,
    createdAt:
      index + 1 === 4 || index + 1 === 5
        ? SHARED_TIMESTAMP
        : `2026-03-20T00:00:${String(index + 1).padStart(2, '0')}.000Z`
  }))
  // Insert the tied pair in reverse id order. A stable sort over rows that
  // arrived in id order would otherwise produce the right answer without any
  // tie-break at all, and the assertion below would pass while asserting
  // nothing — verified: with the pair inserted in order, deleting the
  // in-memory tie-break left the contract green.
  const fourth = messages[3]
  const fifth = messages[4]
  if (fourth && fifth) {
    messages[3] = fifth
    messages[4] = fourth
  }

  storage.createThread({
    thread: { id: 'thread-1', title: 'Thread', updatedAt: '2026-03-20T00:00:00.000Z' },
    createdAt: '2026-03-20T00:00:00.000Z',
    messages
  })
  storage.createThread({
    thread: { id: 'thread-2', title: 'Other', updatedAt: '2026-03-20T00:00:00.000Z' },
    createdAt: '2026-03-20T00:00:00.000Z',
    messages: [
      {
        id: 'other-message-1',
        threadId: 'thread-2',
        role: 'user' as const,
        content: 'Elsewhere',
        status: 'completed' as const,
        createdAt: SHARED_TIMESTAMP
      }
    ]
  })
}

const ALL_IDS = Array.from({ length: 10 }, (_, index) => messageId(index + 1))

export function assertThreadMessagePagingContract(storage: YachiyoStorage): void {
  // Existing callers pass no options, and the agent's context builders are
  // among them: full history, oldest first, exactly as before.
  assert.deepEqual(ids(storage.listThreadMessages('thread-1')), ALL_IDS, 'unpaged full history')

  // A first page is the newest slice, still in reading order.
  assert.deepEqual(
    ids(storage.listThreadMessages('thread-1', { limit: 3 })),
    ['message-08', 'message-09', 'message-10'],
    'newest page in reading order'
  )

  // Walking the whole thread backwards must visit every message exactly once.
  // This is what a tie-break failure actually looks like from outside: the
  // message sharing the boundary timestamp silently never appears.
  const seen: string[] = []
  let cursor: string | undefined
  for (let guard = 0; guard < 20; guard += 1) {
    const page = storage.listThreadMessages('thread-1', {
      limit: 3,
      ...(cursor ? { beforeMessageId: cursor } : {})
    })
    if (page.length === 0) break
    seen.unshift(...ids(page))
    cursor = page[0]?.id
  }
  assert.deepEqual(seen, ALL_IDS, 'no gaps and no repeats while walking backwards')

  // The same tie, stated directly: message-04 shares message-05's timestamp,
  // so a cursor at message-05 must still return message-04.
  assert.deepEqual(
    ids(storage.listThreadMessages('thread-1', { limit: 3, beforeMessageId: 'message-05' })),
    ['message-02', 'message-03', 'message-04'],
    'a cursor returns the message sharing its own timestamp'
  )

  // The top of the thread returns what is left, not a padded page, and reaching
  // the very top is an empty page — which is how the UI learns to stop asking.
  assert.deepEqual(
    ids(storage.listThreadMessages('thread-1', { limit: 3, beforeMessageId: 'message-02' })),
    ['message-01'],
    'partial page at the top'
  )
  assert.deepEqual(
    storage.listThreadMessages('thread-1', { limit: 3, beforeMessageId: 'message-01' }),
    [],
    'empty page past the top'
  )

  // An unknown cursor must not fall back to the newest page: the caller would
  // receive the same messages forever while believing it was walking backwards.
  assert.deepEqual(
    storage.listThreadMessages('thread-1', { limit: 3, beforeMessageId: 'nope' }),
    [],
    'unknown cursor'
  )
  // A cursor naming a real message in another thread is a position in that
  // thread, not this one, so it is as unknown here as an invented id.
  assert.deepEqual(
    storage.listThreadMessages('thread-1', { limit: 3, beforeMessageId: 'other-message-1' }),
    [],
    'foreign cursor'
  )

  // The two options are independent: a cursor that only took effect alongside a
  // limit would hand back the whole thread, including what the caller has.
  assert.deepEqual(
    ids(storage.listThreadMessages('thread-1', { beforeMessageId: 'message-03' })),
    ['message-01', 'message-02'],
    'cursor without limit'
  )

  // `limit: 0` is a legal, meaningful request for an empty page.
  assert.deepEqual(storage.listThreadMessages('thread-1', { limit: 0 }), [], 'zero limit')

  // Paging composes with the lighter projection used for large threads.
  assert.deepEqual(
    ids(storage.listThreadMessages('thread-1', { limit: 2, includeResponseMessages: false })),
    ['message-09', 'message-10'],
    'paging with the light projection'
  )

  for (const limit of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => storage.listThreadMessages('thread-1', { limit }),
      /limit/i,
      `limit ${limit} must be refused`
    )
    // The same refusal must survive a cursor that misses. A store that resolves
    // the cursor first and returns an empty page on a miss never reaches its
    // limit validation, so the illegal argument is silently forgiven on exactly
    // the path where the caller is least likely to notice.
    assert.throws(
      () => storage.listThreadMessages('thread-1', { limit, beforeMessageId: 'nope' }),
      /limit/i,
      `limit ${limit} must be refused even with an unknown cursor`
    )
    assert.throws(
      () => storage.listThreadMessages('thread-1', { limit, beforeMessageId: 'other-message-1' }),
      /limit/i,
      `limit ${limit} must be refused even with a foreign cursor`
    )
  }
}
