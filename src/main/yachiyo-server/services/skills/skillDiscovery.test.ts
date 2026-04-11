import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { discoverSkills, isBundledSkillPath } from './skillDiscovery.ts'
import { buildSkillRegistry } from './skillRegistry.ts'

test('isBundledSkillPath is precise to the Yachiyo home skills dir, not a substring match', () => {
  const homeSkillsDir = '/Users/ringo/.yachiyo/skills'

  // POSIX path under the actual Yachiyo home core dir
  assert.equal(
    isBundledSkillPath('/Users/ringo/.yachiyo/skills/core/core-doctor', homeSkillsDir),
    true,
    'POSIX path inside the Yachiyo home core dir should be bundled'
  )
  // Exact path at the core root (no trailing slash)
  assert.equal(
    isBundledSkillPath('/Users/ringo/.yachiyo/skills/core', homeSkillsDir),
    true,
    'Path ending exactly at core dir should be bundled'
  )

  // WORKSPACE FALSE-POSITIVE REGRESSION GUARD:
  // A repo can legitimately have its own .yachiyo/skills/core/ skill. That
  // path contains the substring `/.yachiyo/skills/core/` but lives under a
  // different root, so discovery classifies it as workspace and we must NOT
  // flag it as bundled.
  assert.equal(
    isBundledSkillPath('/tmp/myrepo/.yachiyo/skills/core/repo-core-skill', homeSkillsDir),
    false,
    'Workspace .yachiyo/skills/core/ must not be mislabeled as bundled'
  )

  // Windows-style Yachiyo home dir + Windows-style skill path
  const winHome = 'C:\\Users\\ringo\\.yachiyo\\skills'
  assert.equal(
    isBundledSkillPath('C:\\Users\\ringo\\.yachiyo\\skills\\core\\core-doctor', winHome),
    true,
    'Windows path inside Windows Yachiyo home core dir should be bundled'
  )
  // Mixed separators (tolerant)
  assert.equal(
    isBundledSkillPath('C:/Users/ringo/.yachiyo/skills/core/core-doctor', winHome),
    true,
    'Mixed-separator path should be bundled'
  )
  // Windows workspace false-positive regression guard
  assert.equal(
    isBundledSkillPath('D:\\work\\myrepo\\.yachiyo\\skills\\core\\foo', winHome),
    false,
    'Workspace path on Windows must not be mislabeled as bundled'
  )

  // Non-bundled custom skill under the same Yachiyo home
  assert.equal(
    isBundledSkillPath('/Users/ringo/.yachiyo/skills/custom/note-taker', homeSkillsDir),
    false,
    'custom/ sibling should not match'
  )
  // Near-miss: core-helpers should NOT match core/
  assert.equal(
    isBundledSkillPath('/Users/ringo/.yachiyo/skills/core-helpers/foo', homeSkillsDir),
    false,
    'core-helpers must not be confused with core'
  )
  // External: .claude/skills/
  assert.equal(
    isBundledSkillPath('/Users/ringo/.claude/skills/helper', homeSkillsDir),
    false,
    'Claude Code skills should not be flagged'
  )
  // Trailing separator on the home dir input is tolerated
  assert.equal(
    isBundledSkillPath('/Users/ringo/.yachiyo/skills/core/foo', '/Users/ringo/.yachiyo/skills/'),
    true,
    'Trailing slash on yachiyoSkillsDir should be ignored'
  )
})

test('isBundledSkillPath respects case on POSIX and ignores case with caseInsensitive: true', () => {
  // POSIX default (case-sensitive): different-case prefix does NOT match.
  // This is the desired behavior on POSIX filesystems, which are case-sensitive.
  assert.equal(
    isBundledSkillPath('/users/ringo/.yachiyo/skills/core/foo', '/Users/ringo/.yachiyo/skills', {
      caseInsensitive: false
    }),
    false,
    'POSIX mode must treat different-case paths as distinct'
  )

  // Windows behavior: a directoryPath whose drive letter or user dir differs
  // in case from YACHIYO_HOME should still match. This is the P1 regression
  // guard for the Windows case-insensitivity fix.
  assert.equal(
    isBundledSkillPath(
      'c:\\users\\ringo\\.yachiyo\\skills\\core\\foo',
      'C:\\Users\\Ringo\\.yachiyo\\skills',
      { caseInsensitive: true }
    ),
    true,
    'Windows mode must match paths that differ only in casing'
  )
  // Mixed separators + mixed case + Windows mode
  assert.equal(
    isBundledSkillPath(
      'C:/Users/RINGO/.Yachiyo/Skills/Core/Foo',
      'c:\\users\\ringo\\.yachiyo\\skills',
      { caseInsensitive: true }
    ),
    true,
    'Mixed separator + mixed case on Windows should match'
  )
  // Windows mode must still reject genuinely different directories
  assert.equal(
    isBundledSkillPath(
      'D:\\work\\myrepo\\.yachiyo\\skills\\core\\foo',
      'C:\\Users\\Ringo\\.yachiyo\\skills',
      { caseInsensitive: true }
    ),
    false,
    'Different drive / workspace path must still not match even in Windows mode'
  )
})

test('buildSkillRegistry propagates the origin field to SkillCatalogEntry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-skill-registry-origin-'))
  const workspacePath = join(root, 'workspace')
  const homePath = join(root, 'home')
  const previousYachiyoHome = process.env['YACHIYO_HOME']
  const previousHome = process.env['HOME']

  process.env['YACHIYO_HOME'] = join(homePath, '.yachiyo')
  process.env['HOME'] = homePath

  try {
    await mkdir(join(homePath, '.yachiyo', 'skills', 'core', 'core-doctor'), { recursive: true })
    await mkdir(join(homePath, '.yachiyo', 'skills', 'custom', 'note-taker'), { recursive: true })
    await mkdir(join(workspacePath, '.yachiyo', 'skills', 'repo-guide'), { recursive: true })

    await writeFile(
      join(homePath, '.yachiyo', 'skills', 'core', 'core-doctor', 'SKILL.md'),
      ['---', 'name: core-doctor', 'description: Bundled', '---', '', '# Core Doctor'].join('\n')
    )
    await writeFile(
      join(homePath, '.yachiyo', 'skills', 'custom', 'note-taker', 'SKILL.md'),
      ['---', 'name: note-taker', 'description: Custom', '---', '', '# Note Taker'].join('\n')
    )
    await writeFile(
      join(workspacePath, '.yachiyo', 'skills', 'repo-guide', 'SKILL.md'),
      ['---', 'name: repo-guide', 'description: Workspace', '---', '', '# Repo Guide'].join('\n')
    )

    const registry = buildSkillRegistry(await discoverSkills([workspacePath]))
    const byName = new Map(registry.map((s) => [s.name, s]))

    assert.equal(
      byName.get('core-doctor')?.origin,
      'bundled',
      'registry must expose bundled origin'
    )
    assert.equal(byName.get('note-taker')?.origin, 'custom', 'registry must expose custom origin')
    assert.equal(
      byName.get('repo-guide')?.origin,
      'workspace',
      'registry must expose workspace origin'
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

test('discoverSkills tags each skill with an origin based on its discovery root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-skill-origin-'))
  const workspacePath = join(root, 'workspace')
  const homePath = join(root, 'home')
  const previousYachiyoHome = process.env['YACHIYO_HOME']
  const previousHome = process.env['HOME']

  process.env['YACHIYO_HOME'] = join(homePath, '.yachiyo')
  process.env['HOME'] = homePath

  try {
    // Yachiyo home: a bundled core skill and a user-custom skill live side by side.
    await mkdir(join(homePath, '.yachiyo', 'skills', 'core', 'core-doctor'), { recursive: true })
    await mkdir(join(homePath, '.yachiyo', 'skills', 'custom', 'note-taker'), { recursive: true })
    // Home third-party fallback: a Claude Code skill.
    await mkdir(join(homePath, '.claude', 'skills', 'claude-helper'), { recursive: true })
    // Workspace Yachiyo skill.
    await mkdir(join(workspacePath, '.yachiyo', 'skills', 'repo-guide'), { recursive: true })
    // Workspace third-party fallback: a Codex skill.
    await mkdir(join(workspacePath, '.codex', 'skills', 'codex-helper'), { recursive: true })

    await writeFile(
      join(homePath, '.yachiyo', 'skills', 'core', 'core-doctor', 'SKILL.md'),
      ['---', 'name: core-doctor', 'description: Bundled', '---', '', '# Core Doctor'].join('\n')
    )
    await writeFile(
      join(homePath, '.yachiyo', 'skills', 'custom', 'note-taker', 'SKILL.md'),
      ['---', 'name: note-taker', 'description: Custom', '---', '', '# Note Taker'].join('\n')
    )
    await writeFile(
      join(homePath, '.claude', 'skills', 'claude-helper', 'SKILL.md'),
      ['---', 'name: claude-helper', 'description: Claude', '---', '', '# Claude Helper'].join('\n')
    )
    await writeFile(
      join(workspacePath, '.yachiyo', 'skills', 'repo-guide', 'SKILL.md'),
      ['---', 'name: repo-guide', 'description: Workspace', '---', '', '# Repo Guide'].join('\n')
    )
    await writeFile(
      join(workspacePath, '.codex', 'skills', 'codex-helper', 'SKILL.md'),
      ['---', 'name: codex-helper', 'description: Codex', '---', '', '# Codex Helper'].join('\n')
    )

    const skills = await discoverSkills([workspacePath])
    const byName = new Map(skills.map((s) => [s.name, s]))

    assert.equal(byName.get('core-doctor')?.origin, 'bundled')
    assert.equal(byName.get('note-taker')?.origin, 'custom')
    assert.equal(byName.get('claude-helper')?.origin, 'external')
    assert.equal(byName.get('repo-guide')?.origin, 'workspace')
    assert.equal(byName.get('codex-helper')?.origin, 'external')
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
