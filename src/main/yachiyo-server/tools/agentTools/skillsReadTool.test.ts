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
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
