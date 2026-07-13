import assert from 'node:assert/strict'
import test from 'node:test'

import { buildFtsSearchPlan, tokenizeQuery } from '../../storage/ftsQuery.ts'
import { SQLITE_SOURCE_QUERY_WORKER_TEXT_HELPERS } from './querySourceSqliteWorkerTextHelpers.ts'

// The worker script embeds hand-maintained copies of the ftsQuery helpers
// (it is evaluated as source text inside a worker thread, so it cannot
// import them). This parity test is what fails when the copies drift.
const workerHelpers = new Function(
  `${SQLITE_SOURCE_QUERY_WORKER_TEXT_HELPERS}; return { tokenizeQuery, buildFtsSearchPlan }`
)() as {
  tokenizeQuery: (query: string) => string[]
  buildFtsSearchPlan: (query: string) => { matchExpr: string; likePatterns: string[] }
}

test('worker text helpers stay in parity with storage/ftsQuery', () => {
  const corpus = [
    'db migration',
    '数据库迁移 v2',
    '搜索',
    'say "hi" ok',
    'Да нет',
    'fix ui bug',
    '工作流程',
    '  ',
    'MiXeD Case Query'
  ]
  for (const query of corpus) {
    assert.deepEqual(workerHelpers.tokenizeQuery(query), tokenizeQuery(query), query)
    assert.deepEqual(workerHelpers.buildFtsSearchPlan(query), buildFtsSearchPlan(query), query)
  }
})
