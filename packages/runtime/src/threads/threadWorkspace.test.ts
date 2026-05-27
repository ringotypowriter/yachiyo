import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { pruneEmptyWorkspaces } from './threadWorkspace.ts'

function makeTempRoot(): string {
  return join(tmpdir(), `thread-workspace-test-${randomUUID()}`)
}

describe('threadWorkspace', () => {
  let tempRoot: string

  beforeEach(async () => {
    tempRoot = makeTempRoot()
    await mkdir(tempRoot, { recursive: true })
  })

  it('pruneEmptyWorkspaces deletes empty directories from oldest to newest', async () => {
    const oldest = randomUUID()
    const middle = randomUUID()
    const newest = randomUUID()

    await mkdir(join(tempRoot, oldest), { recursive: true })
    await mkdir(join(tempRoot, middle), { recursive: true })
    await mkdir(join(tempRoot, newest), { recursive: true })

    // middle has a real file — should be kept
    await writeFile(join(tempRoot, middle, 'file.txt'), 'hello')

    // oldest and newest are empty — should be pruned
    const pruned = await pruneEmptyWorkspaces(tempRoot)
    assert.equal(pruned, 2)

    await assert.rejects(
      () => import('node:fs/promises').then((m) => m.stat(join(tempRoot, oldest))),
      { code: 'ENOENT' }
    )
    await assert.rejects(
      () => import('node:fs/promises').then((m) => m.stat(join(tempRoot, newest))),
      { code: 'ENOENT' }
    )

    const stat = await import('node:fs/promises').then((m) => m.stat(join(tempRoot, middle)))
    assert.ok(stat.isDirectory())
  })

  it('pruneEmptyWorkspaces prunes directories that only have empty .yachiyo subdirs', async () => {
    const threadId = randomUUID()
    const wsPath = join(tempRoot, threadId)
    await mkdir(join(wsPath, '.yachiyo', 'tool-output'), { recursive: true })

    const pruned = await pruneEmptyWorkspaces(tempRoot)
    assert.equal(pruned, 1)

    await assert.rejects(() => import('node:fs/promises').then((m) => m.stat(wsPath)), {
      code: 'ENOENT'
    })
  })

  it('pruneEmptyWorkspaces prunes directories with only disposable .yachiyo files', async () => {
    const threadId = randomUUID()
    const wsPath = join(tempRoot, threadId)
    await mkdir(join(wsPath, '.yachiyo', 'tool-result'), { recursive: true })
    await writeFile(join(wsPath, '.yachiyo', 'tool-result', 'result.md'), 'data')

    const pruned = await pruneEmptyWorkspaces(tempRoot)
    assert.equal(pruned, 1)

    await assert.rejects(() => import('node:fs/promises').then((m) => m.stat(wsPath)), {
      code: 'ENOENT'
    })
  })

  it('pruneEmptyWorkspaces keeps directories with real user files', async () => {
    const threadId = randomUUID()
    const wsPath = join(tempRoot, threadId)
    await mkdir(wsPath, { recursive: true })
    await writeFile(join(wsPath, 'readme.md'), 'hello')

    const pruned = await pruneEmptyWorkspaces(tempRoot)
    assert.equal(pruned, 0)

    const stat = await import('node:fs/promises').then((m) => m.stat(wsPath))
    assert.ok(stat.isDirectory())
  })

  it('pruneEmptyWorkspaces keeps directories with .yachiyo/skills', async () => {
    const threadId = randomUUID()
    const wsPath = join(tempRoot, threadId)
    await mkdir(join(wsPath, '.yachiyo', 'skills', 'my-skill'), { recursive: true })
    await writeFile(join(wsPath, '.yachiyo', 'skills', 'my-skill', 'SKILL.md'), 'skill')

    const pruned = await pruneEmptyWorkspaces(tempRoot)
    assert.equal(pruned, 0)

    const stat = await import('node:fs/promises').then((m) => m.stat(wsPath))
    assert.ok(stat.isDirectory())
  })

  it('pruneEmptyWorkspaces keeps directories with .yachiyo/attachments', async () => {
    const threadId = randomUUID()
    const wsPath = join(tempRoot, threadId)
    await mkdir(join(wsPath, '.yachiyo', 'attachments', 'msg-1'), { recursive: true })
    await writeFile(join(wsPath, '.yachiyo', 'attachments', 'msg-1', 'image.png'), 'png')

    const pruned = await pruneEmptyWorkspaces(tempRoot)
    assert.equal(pruned, 0)

    const stat = await import('node:fs/promises').then((m) => m.stat(wsPath))
    assert.ok(stat.isDirectory())
  })

  it('pruneEmptyWorkspaces keeps directories with USER.md for external channels', async () => {
    const threadId = randomUUID()
    const wsPath = join(tempRoot, threadId)
    await mkdir(wsPath, { recursive: true })
    await writeFile(join(wsPath, 'USER.md'), '# Group\n')

    const pruned = await pruneEmptyWorkspaces(tempRoot)
    assert.equal(pruned, 0)

    const stat = await import('node:fs/promises').then((m) => m.stat(wsPath))
    assert.ok(stat.isDirectory())
  })

  it('pruneEmptyWorkspaces returns 0 when root is missing', async () => {
    await rm(tempRoot, { recursive: true, force: true })
    const pruned = await pruneEmptyWorkspaces(tempRoot)
    assert.equal(pruned, 0)
  })

  it('pruneEmptyWorkspaces respects shouldPrune guard', async () => {
    const allowed = randomUUID()
    const protectedDir = randomUUID()

    await mkdir(join(tempRoot, allowed), { recursive: true })
    await mkdir(join(tempRoot, protectedDir), { recursive: true })

    const pruned = await pruneEmptyWorkspaces(tempRoot, (name) => name === allowed)
    assert.equal(pruned, 1)

    await assert.rejects(
      () => import('node:fs/promises').then((m) => m.stat(join(tempRoot, allowed))),
      { code: 'ENOENT' }
    )

    const stat = await import('node:fs/promises').then((m) => m.stat(join(tempRoot, protectedDir)))
    assert.ok(stat.isDirectory())
  })

  it('cleanup temp dir', async () => {
    await rm(tempRoot, { recursive: true, force: true })
  })
})
