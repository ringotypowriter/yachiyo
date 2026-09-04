import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test, { type TestContext } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Streamdown, type Components } from 'streamdown'

import { resolveExistingFileReferences } from '@yachiyo/runtime/runtime/files/inlineCodeFileReferences'
import { extractUniqueMarkdownFileReferences } from './inlineCodeFileLinkSnapshot.ts'
import { createMarkdownRehypePlugins } from './markdownRehypePlugins.ts'

/**
 * The whole chain in one place: production extraction, the real resolver
 * against real files, and a real Streamdown render of what came back.
 *
 * Every layer here was previously stood in for by a hand-written list, and
 * every defect this feature had lived in one of those stand-ins. In
 * production the middle step crosses a process boundary over IPC; this
 * composes the two halves directly, which is as close as one process gets.
 */
async function renderThroughTheRealChain(
  t: TestContext,
  markdown: string,
  filesOnDisk: string[]
): Promise<string> {
  const workspacePath = await mkdtemp(join(tmpdir(), 'encoded-links-e2e-'))
  t.after(() => rm(workspacePath, { recursive: true, force: true }))
  for (const fileName of filesOnDisk) {
    const filePath = join(workspacePath, fileName)
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, 'x')
  }

  const references = extractUniqueMarkdownFileReferences([markdown])
  const resolved = await resolveExistingFileReferences({
    references,
    workspacePath,
    workspaceOnly: true
  })

  const passthroughSpan: Components['span'] = ({ node, ...props }) => {
    void node
    return React.createElement('span', props)
  }
  return renderToStaticMarkup(
    React.createElement(
      Streamdown,
      {
        mode: 'static',
        rehypePlugins: createMarkdownRehypePlugins(
          null,
          resolved.map((entry) => entry.reference)
        ),
        components: { span: passthroughSpan }
      },
      markdown
    )
  )
}

test('every reserved escape survives extraction, resolution and rendering', async (t) => {
  const html = await renderThroughTheRealChain(
    t,
    [
      '[hash](notes%231.md)',
      '[query](notes%3F1.md)',
      '[nested](docs%2Fnotes.md)',
      '[spaced](my%20file.md)'
    ].join('\n'),
    ['notes#1.md', 'notes?1.md', 'docs/notes.md', 'my file.md']
  )

  assert.match(html, /data-yachiyo-workspace-file-reference="notes#1\.md"/)
  assert.match(html, /data-yachiyo-workspace-file-reference="notes\?1\.md"/)
  assert.match(html, /data-yachiyo-workspace-file-reference="docs\/notes\.md"/)
  assert.match(html, /data-yachiyo-workspace-file-reference="my file\.md"/)
})

test('a literal percent name survives the same chain', async (t) => {
  const html = await renderThroughTheRealChain(t, '[literal](a%2523b.md)', ['a%23b.md'])

  assert.match(html, /data-yachiyo-workspace-file-reference="a%23b\.md"/)
})

test('the raw fallback is what reaches a file named with the escape itself', async (t) => {
  // The only shape where the preferred reading is wrong: the author wrote
  // a%23b.md and the file on disk is called exactly that. Nothing else in this
  // chain exercises the fallback, because everywhere else the decoded reading
  // is the one that exists.
  const html = await renderThroughTheRealChain(t, '[literal](a%23b.md)', ['a%23b.md'])

  assert.match(html, /data-yachiyo-workspace-file-reference="a%23b\.md"/)
})

test('a destination whose decoding would be renamed reaches no file', async (t) => {
  // The dangerous one, end to end: " package.json" must never become the
  // ordinary package.json sitting right there.
  const html = await renderThroughTheRealChain(t, '[trap](%20package.json)', ['package.json'])

  assert.doesNotMatch(html, /data-yachiyo-workspace-file-reference/)
})
