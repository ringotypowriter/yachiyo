import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildFtsSearchPlan,
  ftsMessageSearchSql,
  ftsThreadSearchSql,
  likeMessageSearchSql,
  likeThreadSearchSql,
  toLikeFallbackPatterns,
  toMatchExpression,
  toPhraseMatchExpression
} from './ftsQuery.ts'

function countPlaceholders(sql: string): number {
  return sql.match(/\?/gu)?.length ?? 0
}

test('ftsQuery', async (t) => {
  await t.test('toMatchExpression ORs quoted tokens', () => {
    assert.equal(toMatchExpression('sync bug'), '"sync" OR "bug"')
    assert.equal(toMatchExpression(''), '')
  })

  await t.test('toMatchExpression keeps only trigram-matchable tokens (3+ chars)', () => {
    assert.equal(toMatchExpression('fix ui bug'), '"fix" OR "bug"')
    assert.equal(toMatchExpression('工作流程'), '"工作流程"')
    assert.equal(toMatchExpression('数据库迁移 v2'), '"数据库迁移"')
    // All tokens too short for trigram — callers fall back to LIKE.
    assert.equal(toMatchExpression('搜索 ok'), '')
  })

  await t.test('buildFtsSearchPlan supplements dropped short tokens with LIKE patterns', () => {
    assert.deepEqual(buildFtsSearchPlan('db migration'), {
      matchExpr: '"migration"',
      likePatterns: ['%db%', '%Db%', '%DB%']
    })
    assert.deepEqual(buildFtsSearchPlan('工作流程'), { matchExpr: '"工作流程"', likePatterns: [] })
    assert.deepEqual(buildFtsSearchPlan('搜索'), { matchExpr: '', likePatterns: ['%搜索%'] })
    assert.deepEqual(buildFtsSearchPlan(''), { matchExpr: '', likePatterns: [] })
  })

  await t.test('toPhraseMatchExpression preserves contiguous-substring semantics', () => {
    assert.equal(toPhraseMatchExpression('error handling'), '"error handling"')
    assert.equal(toPhraseMatchExpression('工作 流程'), '"工作 流程"')
    assert.equal(toPhraseMatchExpression('say "hi"'), '"say ""hi"""')
    // Below the trigram minimum — callers fall back to LIKE.
    assert.equal(toPhraseMatchExpression('ok'), '')
    assert.equal(toPhraseMatchExpression('  '), '')
  })

  await t.test('toLikeFallbackPatterns covers common casings of non-ASCII tokens', () => {
    assert.deepEqual(toLikeFallbackPatterns('搜索 ok'), ['%搜索%', '%ok%', '%Ok%', '%OK%'])
    assert.deepEqual(toLikeFallbackPatterns('да'), ['%да%', '%Да%', '%ДА%'])
    assert.deepEqual(toLikeFallbackPatterns('  '), [])
  })

  await t.test('ftsMessageSearchSql binds match expression and row limit', () => {
    const sql = ftsMessageSearchSql('')
    // Contract for both consumers (sqlite storage + CLI): exactly two bound
    // params — MATCH expression and LIMIT — so an unbounded fetch cannot come back.
    assert.equal(countPlaceholders(sql), 2)
    assert.match(sql, /LIMIT \?\s*$/u)
  })

  await t.test('ftsThreadSearchSql binds match expression and limit', () => {
    const sql = ftsThreadSearchSql('')
    assert.equal(countPlaceholders(sql), 2)
    assert.match(sql, /LIMIT \?\s*$/u)
  })

  await t.test('likeMessageSearchSql binds one placeholder per pattern plus limit', () => {
    const sql = likeMessageSearchSql('', 2)
    assert.equal(countPlaceholders(sql), 3)
    assert.match(sql, /LIMIT \?\s*$/u)
  })

  await t.test(
    'likeThreadSearchSql binds title+preview placeholders per pattern plus limit',
    () => {
      const sql = likeThreadSearchSql('', 2)
      assert.equal(countPlaceholders(sql), 5)
      assert.match(sql, /LIMIT \?\s*$/u)
    }
  )
})
