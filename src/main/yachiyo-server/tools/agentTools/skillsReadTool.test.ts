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

test('runSkillsReadTool freezes origin from the catalog entry into each resolved skill', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-skills-read-origin-'))
  const bundledDir = join(root, 'core-skill')
  const customDir = join(root, 'custom-skill')

  try {
    await mkdir(bundledDir, { recursive: true })
    await mkdir(customDir, { recursive: true })
    await writeFile(join(bundledDir, 'SKILL.md'), '# Core Skill')
    await writeFile(join(customDir, 'SKILL.md'), '# Custom Skill')

    const result = await runSkillsReadTool(
      { names: ['core-skill', 'custom-skill'] },
      {
        availableSkills: [
          {
            name: 'core-skill',
            description: 'Bundled core',
            directoryPath: bundledDir,
            skillFilePath: join(bundledDir, 'SKILL.md'),
            origin: 'bundled'
          },
          {
            name: 'custom-skill',
            description: 'User custom',
            directoryPath: customDir,
            skillFilePath: join(customDir, 'SKILL.md'),
            origin: 'custom'
          }
        ]
      }
    )

    assert.equal(result.details.skills[0]?.origin, 'bundled')
    assert.equal(result.details.skills[1]?.origin, 'custom')

    // Origin must also appear in the text content so the model can see it.
    const text = result.content.find((b) => b.type === 'text')
    const textStr = text?.type === 'text' ? text.text : ''
    assert.match(textStr, /Origin: bundled/)
    assert.match(textStr, /Origin: custom/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('runSkillsReadTool omits origin when the catalog entry lacks it (legacy callers)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-skills-read-legacy-'))
  const skillDir = join(root, 'legacy-skill')

  try {
    await mkdir(skillDir, { recursive: true })
    await writeFile(join(skillDir, 'SKILL.md'), '# Legacy')

    const result = await runSkillsReadTool(
      { names: ['legacy-skill'] },
      {
        availableSkills: [
          {
            name: 'legacy-skill',
            description: 'No origin',
            directoryPath: skillDir,
            skillFilePath: join(skillDir, 'SKILL.md')
            // no origin field
          }
        ]
      }
    )

    assert.equal(result.details.skills[0]?.origin, undefined)
    const text = result.content.find((b) => b.type === 'text')
    const textStr = text?.type === 'text' ? text.text : ''
    assert.doesNotMatch(textStr, /Origin:/)
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
