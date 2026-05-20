import assert from 'node:assert/strict'
import test from 'node:test'

import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ensurePlanDocument } from './planModeContext.ts'

test('ensurePlanDocument creates plan.current + plan file once and reuses it', async () => {
  const workspacePath = await mkdtemp(join(tmpdir(), 'yachiyo-plan-mode-'))

  const first = await ensurePlanDocument({ workspacePath, goal: 'Ship Plan Mode' })
  assert.match(first.planRelativePath, /^\.yachiyo\/plan-[a-z]{6}\.md$/)
  assert.ok(first.planAbsolutePath.endsWith(first.planRelativePath.replace(/^\.yachiyo\//, '')))

  const currentPath = join(workspacePath, '.yachiyo', 'plan.current')
  const current = await readFile(currentPath, 'utf8')
  assert.equal(current.trim(), first.planRelativePath.split('/').at(-1))

  const firstMtime = await stat(first.planAbsolutePath).then((s) => s.mtimeMs)

  // A second call should reuse the same file (and not overwrite it).
  await writeFile(first.planAbsolutePath, 'custom content', 'utf8')
  const second = await ensurePlanDocument({ workspacePath, goal: 'Ignored' })
  assert.equal(second.planAbsolutePath, first.planAbsolutePath)
  assert.equal(await readFile(second.planAbsolutePath, 'utf8'), 'custom content')

  const secondMtime = await stat(second.planAbsolutePath).then((s) => s.mtimeMs)
  assert.ok(secondMtime >= firstMtime)
})
