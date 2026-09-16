import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, mkdtemp, open, writeFile, rm, symlink, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveThreadWorkspacePath } from '@yachiyo/runtime/config/paths'
import { MAX_FILE_PREVIEW_BYTES } from '@yachiyo/shared/filePreview'
import { readFilePreview } from './readFilePreview.ts'

test('reads a document relative to an explicit workspace', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'preview-'))
  try {
    await writeFile(join(workspace, 'readme.md'), '# Hello')
    assert.deepEqual(await readFilePreview({ path: 'readme.md', workspacePath: workspace }), {
      path: await realpath(join(workspace, 'readme.md')),
      kind: 'markdown',
      content: '# Hello'
    })
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test('reads a PDF in an ordinary thread without an explicit workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'preview-thread-'))
  const previousHome = process.env['YACHIYO_HOME']
  process.env['YACHIYO_HOME'] = root
  try {
    const threadId = 'preview-thread'
    const workspace = resolveThreadWorkspacePath(threadId)
    await mkdir(workspace, { recursive: true })
    const pdf = '%PDF-1.7\npreview fixture'
    await writeFile(join(workspace, 'test-4.pdf'), pdf)
    assert.deepEqual(await readFilePreview({ path: 'test-4.pdf', threadId, workspacePath: null }), {
      path: await realpath(join(workspace, 'test-4.pdf')),
      kind: 'pdf',
      content: Buffer.from(pdf).toString('base64')
    })
  } finally {
    if (previousHome === undefined) delete process.env['YACHIYO_HOME']
    else process.env['YACHIYO_HOME'] = previousHome
    await rm(root, { recursive: true, force: true })
  }
})

for (const source of ['absolute', 'outside', 'invalid-workspace', 'parent', 'symlink'] as const) {
  test(`allows local preview via ${source} path without workspace confinement`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'preview-local-'))
    const workspace = join(root, 'workspace')
    await mkdir(workspace)
    try {
      const outside = join(root, 'outside.md')
      await writeFile(outside, '# Local document')
      await symlink(outside, join(workspace, 'linked.md'))
      const inputs = {
        absolute: { path: outside },
        outside: { path: outside, workspacePath: workspace },
        'invalid-workspace': { path: outside, workspacePath: join(root, 'missing') },
        parent: { path: '../outside.md', workspacePath: workspace },
        symlink: { path: 'linked.md', workspacePath: workspace }
      }
      assert.deepEqual(await readFilePreview(inputs[source]), {
        path: await realpath(outside),
        kind: 'markdown',
        content: '# Local document'
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
}

test('does not guess the process cwd for relative paths without workspace or thread', async () => {
  await assert.rejects(readFilePreview({ path: 'package.json' }), /workspace or thread/i)
})

test('retains file type, PDF signature, text and size validation for absolute paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'preview-validation-'))
  try {
    await writeFile(join(root, 'fake.pdf'), '<script>not a PDF</script>')
    await assert.rejects(readFilePreview({ path: join(root, 'fake.pdf') }), /not a valid PDF/)
    await writeFile(join(root, 'binary.txt'), new Uint8Array([0, 1, 2]))
    await assert.rejects(readFilePreview({ path: join(root, 'binary.txt') }), /not readable text/)
    await writeFile(join(root, 'program.exe'), 'not previewable')
    await assert.rejects(
      readFilePreview({ path: join(root, 'program.exe') }),
      /default application/
    )
    const largeFile = await open(join(root, 'large.pdf'), 'w')
    try {
      await largeFile.truncate(MAX_FILE_PREVIEW_BYTES + 1)
    } finally {
      await largeFile.close()
    }
    await assert.rejects(readFilePreview({ path: join(root, 'large.pdf') }), /25 MiB/)
    await mkdir(join(root, 'directory.txt'))
    await assert.rejects(readFilePreview({ path: join(root, 'directory.txt') }), /25 MiB/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
