import assert from 'node:assert/strict'
import test from 'node:test'

import { buildDiffFileOpenRequest } from './diffFileOpenRequest.ts'

test('buildDiffFileOpenRequest routes Markdown diffs through the workspace editor', () => {
  assert.deepEqual(
    buildDiffFileOpenRequest({
      workspacePath: '/Users/yuki/project',
      relativePath: 'README.md',
      editorApp: 'editor:zed'
    }),
    {
      path: '/Users/yuki/project/README.md',
      appSelection: 'editor:zed',
      appKind: 'editor'
    }
  )
})
