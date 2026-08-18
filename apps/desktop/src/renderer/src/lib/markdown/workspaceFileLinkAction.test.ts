import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveWorkspaceFileLink } from './workspaceFileLinkAction.ts'

test('resolveWorkspaceFileLink requires a server-resolved workspace reference', () => {
  const links = new Map([['artifact.md', '/workspace/artifact.md']])

  assert.deepEqual(
    resolveWorkspaceFileLink(
      {
        type: 'element',
        properties: { dataYachiyoWorkspaceFileReference: 'artifact.md' }
      },
      links
    ),
    { reference: 'artifact.md', path: '/workspace/artifact.md' }
  )
  assert.equal(
    resolveWorkspaceFileLink(
      {
        type: 'element',
        properties: { dataYachiyoWorkspaceFileReference: '../outside.md' }
      },
      links
    ),
    null
  )
})
