import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { SettingsConfig } from '@yachiyo/shared/protocol'
import { diffSettings, mergeSettings } from './settingsFieldMerge.ts'

function config(partial: Record<string, unknown>): SettingsConfig {
  return partial as unknown as SettingsConfig
}

function get(obj: unknown, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>(
      (acc, key) => (acc == null ? undefined : (acc as Record<string, unknown>)[key]),
      obj
    )
}

describe('diffSettings', () => {
  it('reports only differing leaf fields, ignoring equal ones', () => {
    const local = config({
      general: { themeId: 'dawn', themeAppearance: 'dark' },
      chat: { model: 'a' }
    })
    const remote = config({
      general: { themeId: 'midnight', themeAppearance: 'dark' },
      chat: { model: 'a' }
    })
    const diffs = diffSettings(local, remote)
    assert.deepEqual(diffs, [
      { path: 'general.themeId', localValue: 'dawn', remoteValue: 'midnight' }
    ])
  })

  it('treats arrays as atomic units', () => {
    const local = config({ providers: [{ id: 'p1' }] })
    const remote = config({ providers: [{ id: 'p2' }] })
    const diffs = diffSettings(local, remote)
    assert.equal(diffs.length, 1)
    assert.equal(diffs[0].path, 'providers')
  })

  it('marks fields present on only one side', () => {
    const local = config({ general: { themeId: 'dawn' } })
    const remote = config({ general: { themeId: 'dawn' }, runMode: 'auto' })
    const diffs = diffSettings(local, remote)
    assert.deepEqual(diffs, [{ path: 'runMode', localValue: null, remoteValue: 'auto' }])
  })

  it('ignores object key ordering but respects array ordering', () => {
    const local = config({ a: { x: 1, y: 2 }, list: [1, 2] })
    const remote = config({ a: { y: 2, x: 1 }, list: [2, 1] })
    const diffs = diffSettings(local, remote)
    assert.deepEqual(
      diffs.map((d) => d.path),
      ['list']
    )
  })
})

describe('mergeSettings', () => {
  const local = config({
    general: { themeId: 'dawn', themeAppearance: 'dark' },
    chat: { model: 'local-model' },
    providers: [{ id: 'p1' }]
  })
  const remote = config({
    general: { themeId: 'midnight', themeAppearance: 'dark' },
    chat: { model: 'remote-model' },
    providers: [{ id: 'p2' }]
  })

  it('overrides only fields chosen as remote, preserving the rest', () => {
    const merged = mergeSettings(local, remote, {
      'general.themeId': 'remote',
      'chat.model': 'local'
    })
    assert.equal(get(merged, 'general.themeId'), 'midnight') // took remote
    assert.equal(get(merged, 'general.themeAppearance'), 'dark') // untouched
    assert.equal(get(merged, 'chat.model'), 'local-model') // kept local
    assert.deepEqual(get(merged, 'providers'), [{ id: 'p1' }]) // not selected -> local
  })

  it('keeps everything local when no selections are remote', () => {
    const merged = mergeSettings(local, remote, {})
    assert.deepEqual(merged, local)
  })

  it('does not mutate the input configs', () => {
    const localCopy = structuredClone(local)
    mergeSettings(local, remote, { 'general.themeId': 'remote' })
    assert.deepEqual(local, localCopy)
  })

  it('removes a field when remote lacks it and remote is chosen', () => {
    const withExtra = config({ general: { themeId: 'dawn' }, runMode: 'auto' })
    const withoutExtra = config({ general: { themeId: 'dawn' } })
    const merged = mergeSettings(withExtra, withoutExtra, { runMode: 'remote' })
    assert.equal(get(merged, 'runMode'), undefined)
  })
})
