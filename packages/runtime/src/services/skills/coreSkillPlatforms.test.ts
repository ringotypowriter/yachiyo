import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'

const MAC_ONLY_SKILLS = [
  'yachiyo-kagete',
  'yachiyo-ghostty',
  'yachiyo-macos-apps',
  'yachiyo-macos-screenshot'
]

test('the four macOS-only bundled skills declare darwin platform metadata', async () => {
  const coreSkillsRoot = resolve(import.meta.dirname, '../../../../core-skills/core-skills')

  for (const name of MAC_ONLY_SKILLS) {
    const content = await readFile(resolve(coreSkillsRoot, name, 'SKILL.md'), 'utf8')
    assert.match(content, /^platforms:\s*darwin\s*$/mu, `${name} must be restricted to darwin`)
  }
})
