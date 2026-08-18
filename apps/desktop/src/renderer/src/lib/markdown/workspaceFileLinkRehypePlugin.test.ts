import assert from 'node:assert/strict'
import test from 'node:test'

import {
  WORKSPACE_FILE_REFERENCE_PROPERTY,
  rewriteWorkspaceFileLinksForHarden
} from './workspaceFileLinkRehypePlugin.ts'

test('rewriteWorkspaceFileLinksForHarden protects only resolved workspace links from harden', () => {
  const resolvedReference = 'pi-agent-compact-prompt.md'
  const tree = {
    type: 'root',
    children: [
      {
        type: 'element',
        tagName: 'a',
        properties: { href: resolvedReference },
        children: [{ type: 'text', value: '下载提示词' }]
      },
      {
        type: 'element',
        tagName: 'a',
        properties: { href: '../outside.md' },
        children: [{ type: 'text', value: '外部文件' }]
      }
    ]
  }

  rewriteWorkspaceFileLinksForHarden(tree, new Set([resolvedReference]))

  assert.deepEqual(tree.children[0], {
    type: 'element',
    tagName: 'span',
    properties: { [WORKSPACE_FILE_REFERENCE_PROPERTY]: resolvedReference },
    children: [{ type: 'text', value: '下载提示词' }]
  })
  assert.equal(tree.children[1]?.tagName, 'a')
  assert.deepEqual(tree.children[1]?.properties, { href: '../outside.md' })
})
