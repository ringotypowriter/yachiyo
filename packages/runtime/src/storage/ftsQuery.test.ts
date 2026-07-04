import assert from 'node:assert/strict'
import test from 'node:test'

import { ftsMessageSearchSql, ftsThreadSearchSql, toMatchExpression } from './ftsQuery.ts'

function countPlaceholders(sql: string): number {
  return sql.match(/\?/gu)?.length ?? 0
}

test('ftsQuery', async (t) => {
  await t.test('toMatchExpression ORs quoted tokens', () => {
    assert.equal(toMatchExpression('sync bug'), '"sync" OR "bug"')
    assert.equal(toMatchExpression(''), '')
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
})
