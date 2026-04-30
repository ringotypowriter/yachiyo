import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { runSkillsReadTool } from './skillsReadTool.ts'

test('runSkillsReadTool returns metadata without full SKILL.md content', async () => {
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
