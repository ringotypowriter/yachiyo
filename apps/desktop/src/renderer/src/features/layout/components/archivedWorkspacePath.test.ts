import { describe, it } from 'node:test'
import { strict as assert } from 'node:assert'

import { resolveArchivedWorkspacePath } from './archivedWorkspacePath.ts'

describe('resolveArchivedWorkspacePath', () => {
  it('uses the thread workspace path when it exists', () => {
    assert.equal(
      resolveArchivedWorkspacePath('/Users/alice/thread-workspace', [
        { workspacePath: '/Users/alice/run-workspace' }
      ]),
      '/Users/alice/thread-workspace'
    )
  })

  it('uses the latest run workspace path when the archived thread has no workspace', () => {
    assert.equal(
      resolveArchivedWorkspacePath(null, [
        { workspacePath: '/Users/alice/old-workspace' },
        { workspacePath: null },
        { workspacePath: '/Users/alice/new-workspace' }
      ]),
      '/Users/alice/new-workspace'
    )
  })
})
