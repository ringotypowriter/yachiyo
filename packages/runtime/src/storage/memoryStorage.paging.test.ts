import test from 'node:test'

import { createInMemoryYachiyoStorage } from './memoryStorage.ts'
import {
  assertThreadMessagePagingContract,
  seedThreadMessagePagingFixture
} from './threadMessagePagingContract.test.ts'

/**
 * The paging contract run against the in-memory store — in the normal Node
 * suite, so this is the part of the contract CI actually gates.
 *
 * The sqlite reader runs the same assertions in `sqlite.native.test.ts`, which
 * only runs under Electron. Between them the contract is written once; only
 * this one blocks a merge.
 */
test('the in-memory store honours the thread message paging contract', () => {
  const storage = createInMemoryYachiyoStorage()
  seedThreadMessagePagingFixture(storage)
  assertThreadMessagePagingContract(storage)
  storage.close()
})
