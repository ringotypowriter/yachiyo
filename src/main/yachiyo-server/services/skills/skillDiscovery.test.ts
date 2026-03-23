import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { discoverSkills } from './skillDiscovery.ts'
import { buildSkillRegistry } from './skillRegistry.ts'

test('discoverSkills scans workspace-local and home/global roots with precedence by name', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-skill-discovery-'))
  const workspacePath = join(root, 'workspace')
  const homePath = join(root, 'home')
  const previousYachiyoHome = process.env['YACHIYO_HOME']
  const previousHome = process.env['HOME']

  process.env['YACHIYO_HOME'] = join(homePath, '.yachiyo')
  process.env['HOME'] = homePath

  try {
    await mkdir(join(workspacePath, '.codex', 'skills', 'writer-skill'), { recursive: true })
    await mkdir(join(workspacePath, '.yachiyo', 'skills', 'writer-skill'), { recursive: true })
    await mkdir(join(homePath, '.codex', 'skills', 'writer-skill'), { recursive: true })
    await mkdir(join(homePath, '.claude', 'skills', 'global-skill'), { recursive: true })

    await writeFile(
      join(workspacePath, '.codex', 'skills', 'writer-skill', 'SKILL.md'),
      [
        '---',
        'name: writer-skill',
        'description: Workspace Codex version',
        '---',
        '',
        '# Writer'
      ].join('\n')
    )
    await writeFile(
      join(workspacePath, '.yachiyo', 'skills', 'writer-skill', 'SKILL.md'),
      [
        '---',
        'name: writer-skill',
        'description: Workspace Yachiyo version',
        '---',
        '',
        '# Writer'
      ].join('\n')
    )
    await writeFile(
      join(homePath, '.codex', 'skills', 'writer-skill', 'SKILL.md'),
      ['---', 'name: writer-skill', 'description: Home version', '---', '', '# Writer'].join('\n')
    )
    await writeFile(
      join(homePath, '.claude', 'skills', 'global-skill', 'SKILL.md'),
      ['# Global Skill', '', 'Global description.'].join('\n')
    )

    const registry = buildSkillRegistry(await discoverSkills([workspacePath]))

    assert.equal(registry.length, 2)
    assert.equal(registry[0]?.name, 'writer-skill')
    assert.equal(registry[0]?.description, 'Workspace Yachiyo version')
    assert.equal(
      registry[0]?.directoryPath,
      join(workspacePath, '.yachiyo', 'skills', 'writer-skill')
    )
    assert.equal(registry[1]?.name, 'Global Skill')
  } finally {
    if (previousYachiyoHome === undefined) {
      delete process.env['YACHIYO_HOME']
    } else {
      process.env['YACHIYO_HOME'] = previousYachiyoHome
    }
    if (previousHome === undefined) {
      delete process.env['HOME']
    } else {
      process.env['HOME'] = previousHome
    }
    await rm(root, { recursive: true, force: true })
  }
})

test('discoverSkills tolerates malformed frontmatter and missing frontmatter', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-skill-discovery-'))
  const workspacePath = join(root, 'workspace')
  const homePath = join(root, 'home')
  const previousYachiyoHome = process.env['YACHIYO_HOME']
  const previousHome = process.env['HOME']

  process.env['YACHIYO_HOME'] = join(homePath, '.yachiyo')
  process.env['HOME'] = homePath

  try {
    await mkdir(join(workspacePath, '.agents', 'skills', 'broken-skill'), { recursive: true })
    await mkdir(join(workspacePath, '.claude', 'skills', 'plain-skill'), { recursive: true })

    await writeFile(
      join(workspacePath, '.agents', 'skills', 'broken-skill', 'SKILL.md'),
      ['---', 'name broken', 'description: Falls back safely', '---', '', '# Broken Skill'].join(
        '\n'
      )
    )
    await writeFile(
      join(workspacePath, '.claude', 'skills', 'plain-skill', 'SKILL.md'),
      ['# Plain Skill', '', 'Readable summary from body.'].join('\n')
    )

    const registry = buildSkillRegistry(await discoverSkills([workspacePath]))

    assert.deepEqual(
      registry.map((skill) => ({ name: skill.name, description: skill.description })),
      [
        {
          name: 'Broken Skill',
          description: 'Falls back safely'
        },
        {
          name: 'Plain Skill',
          description: 'Readable summary from body.'
        }
      ]
    )
  } finally {
    if (previousYachiyoHome === undefined) {
      delete process.env['YACHIYO_HOME']
    } else {
      process.env['YACHIYO_HOME'] = previousYachiyoHome
    }
    if (previousHome === undefined) {
      delete process.env['HOME']
    } else {
      process.env['HOME'] = previousHome
    }
    await rm(root, { recursive: true, force: true })
  }
})
