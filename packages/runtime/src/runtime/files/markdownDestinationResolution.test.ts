import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'

import { toMarkdownDestinationCandidates } from '@yachiyo/shared/inlineCodeFileReferences'
import { resolveExistingFileReferences } from './inlineCodeFileReferences.ts'

async function workspaceWith(t: TestContext, fileNames: string[]): Promise<string> {
  const workspacePath = await mkdtemp(join(tmpdir(), 'markdown-destinations-'))
  // Registered before the files exist, so a failure part-way through still
  // takes the directory with it.
  t.after(() => rm(workspacePath, { recursive: true, force: true }))
  for (const fileName of fileNames) {
    await writeFile(join(workspacePath, fileName), 'x')
  }
  return workspacePath
}

test('a destination that decodes to a NUL byte does not break the whole batch', async (t) => {
  // The decoded reading of a%00.md contains a real NUL, which node's fs layer
  // refuses with a TypeError rather than "not found". One such link in a
  // message would take every other reference in the same batch down with it.
  const workspacePath = await workspaceWith(t, ['ordinary.md'])

  const resolved = await resolveExistingFileReferences({
    references: [...toMarkdownDestinationCandidates('a%00.md'), 'ordinary.md'],
    workspacePath,
    workspaceOnly: true
  })

  assert.deepEqual(
    resolved.map((entry) => entry.reference),
    ['ordinary.md']
  )
})

test('a file literally named with a percent escape still resolves', async (t) => {
  // The raw reading is what keeps these reachable; dropping the decoded
  // candidate must not take the literal one with it.
  const workspacePath = await workspaceWith(t, ['a%00.md'])

  const resolved = await resolveExistingFileReferences({
    references: toMarkdownDestinationCandidates('a%00.md'),
    workspacePath,
    workspaceOnly: true
  })

  assert.deepEqual(
    resolved.map((entry) => entry.reference),
    ['a%00.md']
  )
})

test('an ordinary encoded destination resolves through the real resolver', async (t) => {
  // The layer the rest of this feature's tests stubbed out.
  const workspacePath = await workspaceWith(t, ['a b.md', 'c#d.md'])

  const resolved = await resolveExistingFileReferences({
    references: [
      ...toMarkdownDestinationCandidates('a%20b.md'),
      ...toMarkdownDestinationCandidates('c%23d.md')
    ],
    workspacePath,
    workspaceOnly: true
  })

  assert.deepEqual(resolved.map((entry) => entry.reference).sort(), ['a b.md', 'c#d.md'])
})

test('a destination whose decoding would be renamed never opens the renamed file', async (t) => {
  // The dangerous shape: the decoded reading names a file with leading or
  // trailing whitespace, and trimming turns it into an ordinary — often
  // present — file. Resolving to that file would be silently opening the
  // wrong one.
  const workspacePath = await workspaceWith(t, ['package.json'])

  for (const destination of ['%20package.json', '%0Apackage.json', 'package.json%20']) {
    const resolved = await resolveExistingFileReferences({
      references: toMarkdownDestinationCandidates(destination),
      workspacePath,
      workspaceOnly: true
    })

    assert.deepEqual(
      resolved.map((entry) => entry.reference),
      [],
      `must not resolve ${destination} to the trimmed file`
    )
  }
})

test('an unencoded reference to that same file still resolves', async (t) => {
  // The guard above must not make the ordinary destination unreachable.
  const workspacePath = await workspaceWith(t, ['package.json'])

  const resolved = await resolveExistingFileReferences({
    references: toMarkdownDestinationCandidates('package.json'),
    workspacePath,
    workspaceOnly: true
  })

  assert.deepEqual(
    resolved.map((entry) => entry.reference),
    ['package.json']
  )
})
