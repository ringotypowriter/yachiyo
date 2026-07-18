import assert from 'node:assert/strict'
import test from 'node:test'
import { buildAskUserBranchDraft } from './askUserBranchDraft.ts'

test('quotes a single-line question and puts the cursor after the blank line', () => {
  const draft = buildAskUserBranchDraft('Which DB?')

  assert.equal(draft.text, '> Which DB?\n\n')
  assert.equal(draft.initialCursorOffset, draft.text.length)
})

test('quotes every line of a multi-line question', () => {
  const draft = buildAskUserBranchDraft('Which DB?\nsqlite or postgres')

  assert.equal(draft.text, '> Which DB?\n> sqlite or postgres\n\n')
  assert.equal(draft.initialCursorOffset, draft.text.length)
})
