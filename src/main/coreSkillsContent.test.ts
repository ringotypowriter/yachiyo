import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  rewriteBundledCoreSkillContent,
  rewriteBundledCoreSkillMarkdownFiles
} from './coreSkillsContent.ts'

test('rewriteBundledCoreSkillContent replaces bundled repo paths with installed target paths', () => {
  const content =
    'python3 resources/core-skills/yachiyo-docx/scripts/docx_inspect.py path/to/file.docx --json'

  const rewritten = rewriteBundledCoreSkillContent(content, '/Users/test/.yachiyo/skills/core')

  assert.equal(
    rewritten,
    'python3 /Users/test/.yachiyo/skills/core/yachiyo-docx/scripts/docx_inspect.py path/to/file.docx --json'
  )
})

test('rewriteBundledCoreSkillMarkdownFiles rewrites markdown files in place', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-core-skills-'))

  try {
    const skillDir = join(root, 'yachiyo-docx')
    const referenceDir = join(skillDir, 'references')
    await mkdir(referenceDir, { recursive: true })
    await writeFile(
      join(skillDir, 'SKILL.md'),
      'python3 resources/core-skills/yachiyo-docx/scripts/docx_inspect.py path/to/file.docx --json\n',
      'utf8'
    )
    await writeFile(
      join(referenceDir, 'guide.md'),
      'python3 resources/core-skills/yachiyo-docx/scripts/docx_fill_template.py input.docx output.docx --json\n',
      'utf8'
    )
    await writeFile(
      join(skillDir, 'notes.txt'),
      'resources/core-skills/yachiyo-docx/scripts/docx_inspect.py'
    )

    rewriteBundledCoreSkillMarkdownFiles(root)

    assert.equal(
      await readFile(join(skillDir, 'SKILL.md'), 'utf8'),
      `python3 ${root.replace(/\\/gu, '/')}/yachiyo-docx/scripts/docx_inspect.py path/to/file.docx --json\n`
    )
    assert.equal(
      await readFile(join(referenceDir, 'guide.md'), 'utf8'),
      `python3 ${root.replace(/\\/gu, '/')}/yachiyo-docx/scripts/docx_fill_template.py input.docx output.docx --json\n`
    )
    assert.equal(
      await readFile(join(skillDir, 'notes.txt'), 'utf8'),
      'resources/core-skills/yachiyo-docx/scripts/docx_inspect.py'
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
