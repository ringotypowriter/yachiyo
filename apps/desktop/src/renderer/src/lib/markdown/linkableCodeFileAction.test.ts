import assert from 'node:assert/strict'
import test from 'node:test'

import {
  getLinkableCodeFileAction,
  resolveTimelineFileOpenTarget
} from './linkableCodeFileAction.ts'

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

test('resolveTimelineFileOpenTarget uses the configured Markdown app for Markdown files', () => {
  assert.deepEqual(
    resolveTimelineFileOpenTarget({
      filePath: 'C:\\Users\\Yuki\\Notes & Plans\\README.md',
      editorApp: 'editor:zed',
      markdownApp: 'markdown:obsidian'
    }),
    {
      mode: 'configured',
      appSelection: 'markdown:obsidian',
      appKind: 'markdown'
    }
  )
})

test('resolveTimelineFileOpenTarget uses the default application when no Markdown app is configured', () => {
  assert.deepEqual(
    resolveTimelineFileOpenTarget({
      filePath: '/Users/yuki/notes/README.MARKDOWN',
      editorApp: 'editor:zed'
    }),
    { mode: 'default' }
  )
})

test('resolveTimelineFileOpenTarget keeps non-Markdown files on the workspace editor', () => {
  assert.deepEqual(
    resolveTimelineFileOpenTarget({
      filePath: '/Users/yuki/project/src/App.tsx',
      editorApp: 'editor:zed',
      markdownApp: 'markdown:obsidian'
    }),
    {
      mode: 'configured',
      appSelection: 'editor:zed',
      appKind: 'editor'
    }
  )
  assert.deepEqual(resolveTimelineFileOpenTarget({ filePath: '/Users/yuki/project/src/App.tsx' }), {
    mode: 'unavailable'
  })
})
