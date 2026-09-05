import assert from 'node:assert/strict'
import { test } from 'node:test'
import { appendReaderReference, readerReference, type ReaderTarget } from './contentReader.ts'

const doc: ReaderTarget = {
  kind: 'file',
  threadId: 'a',
  path: '/work/report.md',
  workspacePath: '/work'
}
test('reading context belongs only to its conversation and is persisted as a file reference', () => {
  const reference = readerReference(doc, 'a')
  assert.ok(reference?.includes('/work/report.md'))
  assert.equal(readerReference(doc, 'b'), null)
  assert.equal(appendReaderReference('Revise this', reference), `Revise this\n\n${reference}`)
  assert.equal(appendReaderReference('Revise this', null), 'Revise this')
  const sent = appendReaderReference('Revise this', reference)
  assert.equal(appendReaderReference(sent, reference), sent)
})
test('diff references identify both the run and the selected file', () => {
  const reference = readerReference(
    {
      kind: 'diff',
      threadId: 'a',
      runId: 'run-7',
      workspacePath: '/work',
      relativePath: 'src/main.ts'
    },
    'a'
  )
  assert.ok(reference?.includes('run-7'))
  assert.ok(reference?.includes('src/main.ts'))
  assert.ok(reference?.includes('/work'))
})
test('data images do not insert a base64 payload into text', () => {
  assert.equal(
    readerReference({ kind: 'image', threadId: 'a', src: 'data:image/png;base64,abc' }, 'a'),
    null
  )
})
