import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { runSkillsReadTool } from './skillsReadTool.ts'

test('runSkillsReadTool omits full SKILL.md content by default', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-skills-read-'))
  const skillDir = join(root, 'workspace-refactor')
  const skillFilePath = join(skillDir, 'SKILL.md')

  try {
    await mkdir(skillDir, { recursive: true })
    await writeFile(skillFilePath, '# Workspace Refactor\n\nDetailed instructions.')

    const result = await runSkillsReadTool(
      {
        names: ['workspace-refactor']
      },
      {
        availableSkills: [
          {
            name: 'workspace-refactor',
            description: 'Workspace refactor guide',
            directoryPath: skillDir,
            skillFilePath
          }
        ]
      }
    )

    const text = result.content.find((b) => b.type === 'text')
    assert.equal(result.details.resolvedCount, 1)
    assert.equal(result.details.skills[0]?.content, undefined)
    assert.match(text?.type === 'text' ? text.text : '', /Workspace refactor guide/)
    assert.doesNotMatch(text?.type === 'text' ? text.text : '', /Detailed instructions/)
    assert.match(text?.type === 'text' ? text.text : '', /SKILL\.md:/)
    assert.match(text?.type === 'text' ? text.text : '', /Use the read tool on SKILL\.md/)
    assert.match(text?.type === 'text' ? text.text : '', /relative to the skill folder/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('runSkillsReadTool includes full SKILL.md content only when explicitly requested', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-skills-read-'))
  const skillDir = join(root, 'workspace-refactor')
  const skillFilePath = join(skillDir, 'SKILL.md')

  try {
    await mkdir(skillDir, { recursive: true })
    await writeFile(skillFilePath, '# Workspace Refactor\n\nDetailed instructions.')

    const result = await runSkillsReadTool(
      {
        names: ['workspace-refactor'],
        includeContent: true
      },
      {
        availableSkills: [
          {
            name: 'workspace-refactor',
            description: 'Workspace refactor guide',
            directoryPath: skillDir,
            skillFilePath
          }
        ]
      }
    )

    const text = result.content.find((b) => b.type === 'text')
    assert.equal(
      result.details.skills[0]?.content,
      '# Workspace Refactor\n\nDetailed instructions.'
    )
    assert.match(text?.type === 'text' ? text.text : '', /Detailed instructions/)
    assert.doesNotMatch(text?.type === 'text' ? text.text : '', /Use the read tool on SKILL\.md/)
    assert.match(text?.type === 'text' ? text.text : '', /relative to the skill folder/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('runSkillsReadTool rewrites relative markdown links to absolute paths when including content', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-skills-read-'))
  const skillDir = join(root, 'my-skill')
  const skillFilePath = join(skillDir, 'SKILL.md')

  try {
    await mkdir(skillDir, { recursive: true })
    await writeFile(
      skillFilePath,
      '# My Skill\n\nRead [guide](references/guide.md) and see ![diagram](assets/diagram.png).'
    )

    const result = await runSkillsReadTool(
      {
        names: ['my-skill'],
        includeContent: true
      },
      {
        availableSkills: [
          {
            name: 'my-skill',
            description: 'My skill guide',
            directoryPath: skillDir,
            skillFilePath
          }
        ]
      }
    )

    const content = result.details.skills[0]?.content ?? ''
    assert.match(
      content,
      new RegExp(`\\[guide\\]\\(${root.replace(/\\/gu, '/')}/my-skill/references/guide.md\\)`)
    )
    assert.match(
      content,
      new RegExp(`\\!\\[diagram\\]\\(${root.replace(/\\/gu, '/')}/my-skill/assets/diagram.png\\)`)
    )
    assert.doesNotMatch(content, /\(references\/guide\.md\)/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
