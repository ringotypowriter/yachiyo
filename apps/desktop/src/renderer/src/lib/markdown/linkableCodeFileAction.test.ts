import assert from 'node:assert/strict'
import test from 'node:test'

import { getLinkableCodeFileAction } from './linkableCodeFileAction.ts'

test('getLinkableCodeFileAction opens file references on normal click', () => {
  assert.equal(getLinkableCodeFileAction({ reference: 'src/App.tsx', altKey: false }), 'open')
})

test('getLinkableCodeFileAction reveals file references on alt click', () => {
  assert.equal(getLinkableCodeFileAction({ reference: 'src/App.tsx', altKey: true }), 'reveal')
  assert.equal(getLinkableCodeFileAction({ reference: 'src/App.tsx:12', altKey: true }), 'reveal')
})

test('getLinkableCodeFileAction opens folder references even on alt click', () => {
  assert.equal(getLinkableCodeFileAction({ reference: 'results/', altKey: true }), 'open')
  assert.equal(getLinkableCodeFileAction({ reference: 'results\\', altKey: true }), 'open')
})
