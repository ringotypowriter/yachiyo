import assert from 'node:assert/strict'
import test from 'node:test'

import type { SkillCatalogEntry } from '@yachiyo/shared/protocol'
import { createCachedSkillCatalogLoader } from './skillCatalogCache.ts'

function makeEntry(name: string): SkillCatalogEntry {
  return {
    name,
    description: `${name} description`,
    scope: 'home',
    skillFilePath: `/skills/${name}/SKILL.md`,
    directoryPath: `/skills/${name}`
  } as SkillCatalogEntry
}

test('cached skill catalog loader', async (t) => {
  await t.test(
    'serves repeat calls for the same workspaces from cache within the TTL',
    async () => {
      let loads = 0
      const now = 0
      const loader = createCachedSkillCatalogLoader({
        loadCatalog: async (paths) => {
          loads++
          return [makeEntry(`skill-${paths.join(',')}-${loads}`)]
        },
        ttlMs: 15_000,
        now: () => now
      })

      const first = await loader(['/ws/a'])
      const second = await loader(['/ws/a'])
      assert.equal(loads, 1)
      assert.deepEqual(second, first)
    }
  )

  await t.test('reloads after the TTL expires', async () => {
    let loads = 0
    let now = 0
    const loader = createCachedSkillCatalogLoader({
      loadCatalog: async () => {
        loads++
        return [makeEntry(`skill-${loads}`)]
      },
      ttlMs: 15_000,
      now: () => now
    })

    await loader(['/ws/a'])
    now = 15_001
    const reloaded = await loader(['/ws/a'])
    assert.equal(loads, 2)
    assert.equal(reloaded[0]?.name, 'skill-2')
  })

  await t.test('caches per workspace set and ignores path order', async () => {
    let loads = 0
    const loader = createCachedSkillCatalogLoader({
      loadCatalog: async () => {
        loads++
        return []
      },
      ttlMs: 15_000,
      now: () => 0
    })

    await loader(['/ws/a', '/ws/b'])
    await loader(['/ws/b', '/ws/a'])
    assert.equal(loads, 1)
    await loader(['/ws/c'])
    assert.equal(loads, 2)
  })

  await t.test('concurrent calls for the same key share one in-flight load', async () => {
    let loads = 0
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const loader = createCachedSkillCatalogLoader({
      loadCatalog: async () => {
        loads++
        await gate
        return [makeEntry('shared')]
      },
      ttlMs: 15_000,
      now: () => 0
    })

    const [a, b] = [loader(['/ws/a']), loader(['/ws/a'])]
    release?.()
    const [resultA, resultB] = await Promise.all([a, b])
    assert.equal(loads, 1)
    assert.equal(resultA[0]?.name, 'shared')
    assert.deepEqual(resultB, resultA)
  })

  await t.test('a failed load is not cached', async () => {
    let loads = 0
    const loader = createCachedSkillCatalogLoader({
      loadCatalog: async () => {
        loads++
        if (loads === 1) throw new Error('disk hiccup')
        return [makeEntry('recovered')]
      },
      ttlMs: 15_000,
      now: () => 0
    })

    await assert.rejects(() => loader(['/ws/a']), /disk hiccup/)
    const recovered = await loader(['/ws/a'])
    assert.equal(loads, 2)
    assert.equal(recovered[0]?.name, 'recovered')
  })
})
