import assert from 'node:assert/strict'
import test from 'node:test'

import type { ActivitySourceRecord } from '@yachiyo/shared/protocol'
import {
  addExcludedApp,
  buildRecentActivityAppOptions,
  parseExcludedAppTokens,
  removeExcludedApp
} from './activityExcludedApps.ts'

function record(entries: ActivitySourceRecord['entries']): ActivitySourceRecord {
  return {
    id: 'activity-example',
    threadId: 'thread-example',
    runId: 'run-example',
    requestMessageId: 'message-example',
    startedAt: '2026-05-17T00:00:00.000Z',
    endedAt: '2026-05-17T00:01:00.000Z',
    totalDurationMs: 60_000,
    uniqueApps: entries.length,
    summaryText: 'Example activity',
    entries,
    createdAt: '2026-05-17T00:01:00.000Z'
  }
}

test('parseExcludedAppTokens splits lines and commas, trims, and de-duplicates', () => {
  assert.deepEqual(
    parseExcludedAppTokens('Example Chat, com.example.chat\n example chat \nExample Mail'),
    ['Example Chat', 'com.example.chat', 'Example Mail']
  )
})

test('addExcludedApp and removeExcludedApp preserve readable labels', () => {
  const apps = addExcludedApp(['Example Chat'], 'com.example.chat')

  assert.deepEqual(apps, ['Example Chat', 'com.example.chat'])
  assert.deepEqual(removeExcludedApp(apps, 'example chat'), ['com.example.chat'])
})

test('buildRecentActivityAppOptions returns recent unique apps not already excluded', () => {
  const options = buildRecentActivityAppOptions(
    [
      record([
        { appName: 'Example Editor', bundleId: 'com.example.editor', durationMs: 20_000 },
        { appName: 'Example Chat', bundleId: 'com.example.chat', durationMs: 10_000 }
      ]),
      record([
        { appName: 'Example Editor', bundleId: 'com.example.editor', durationMs: 15_000 },
        { appName: 'Example Browser', bundleId: 'com.example.browser', durationMs: 12_000 }
      ])
    ],
    ['Example Chat']
  )
  assert.deepEqual(
    options.map((option) => [option.appName, option.bundleId, option.totalDurationMs]),
    [
      ['Example Editor', 'com.example.editor', 35_000],
      ['Example Browser', 'com.example.browser', 12_000]
    ]
  )
})
