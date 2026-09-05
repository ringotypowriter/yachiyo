import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, writeFile, rm, symlink, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFilePreview } from './readFilePreview.ts'

test('reads a workspace document and rejects files outside it, including symlink escapes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'preview-'))
  const workspace = join(root, 'workspace')
  const { mkdir } = await import('node:fs/promises')
  await mkdir(workspace)
  try {
    await writeFile(join(workspace, 'readme.md'), '# Hello')
    await writeFile(join(root, 'outside.md'), 'private')
    await symlink(join(root, 'outside.md'), join(workspace, 'escape.md'))
    assert.deepEqual(await readFilePreview({ path: 'readme.md', workspacePath: workspace }), {
      path: await realpath(join(workspace, 'readme.md')),
      kind: 'markdown',
      content: '# Hello'
    })
    await assert.rejects(readFilePreview({ path: '../outside.md', workspacePath: workspace }))
    await assert.rejects(readFilePreview({ path: 'escape.md', workspacePath: workspace }))
    await assert.rejects(readFilePreview({ path: join(root, 'outside.md') }))
    await writeFile(join(workspace, 'fake.pdf'), '<script>not a PDF</script>')
    await assert.rejects(readFilePreview({ path: 'fake.pdf', workspacePath: workspace }))
    await writeFile(join(workspace, 'binary.txt'), new Uint8Array([0, 1, 2]))
    await assert.rejects(readFilePreview({ path: 'binary.txt', workspacePath: workspace }))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
