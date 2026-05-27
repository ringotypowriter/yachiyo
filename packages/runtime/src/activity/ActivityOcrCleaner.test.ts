import assert from 'node:assert/strict'
import test from 'node:test'

import { cleanActivityOcrLines } from './ActivityOcrCleaner.ts'

test('cleanActivityOcrLines removes low-confidence, duplicate, and language-agnostic UI noise', () => {
  const result = cleanActivityOcrLines({
    lines: [
      { text: 'File', confidence: 1 },
      { text: 'Window', confidence: 1 },
      { text: '編集', confidence: 1 },
      { text: '窗口', confidence: 1 },
      { text: 'Activity Tracker Design', confidence: 0.92 },
      { text: 'Activity Tracker Design', confidence: 0.91 },
      { text: 'querySource snapshots should stay quiet', confidence: 0.88 },
      { text: 'garbled', confidence: 0.2 }
    ]
  })

  assert.ok(result)
  assert.equal(result.text, 'Activity Tracker Design\nquerySource snapshots should stay quiet')
  assert.equal(result.lineCount, 2)
  assert.equal(result.confidence, 0.9)
  assert.equal(result.excerpt, 'Activity Tracker Design querySource snapshots should stay quiet')
  assert.match(result.contentHash, /^sha256:/)
})

test('cleanActivityOcrLines keeps useful multilingual text without language-specific allowlists', () => {
  const result = cleanActivityOcrLines({
    lines: [
      { text: '測定不確かさの評価手順', confidence: 0.93 },
      { text: '불확도 계산 결과 검토', confidence: 0.89 },
      { text: 'Measurement uncertainty worksheet', confidence: 0.94 }
    ]
  })

  assert.ok(result)
  assert.equal(
    result.text,
    '測定不確かさの評価手順\n불확도 계산 결과 검토\nMeasurement uncertainty worksheet'
  )
})

test('cleanActivityOcrLines drops snapshots with too little useful text', () => {
  assert.equal(
    cleanActivityOcrLines({
      lines: [
        { text: 'Window', confidence: 1 },
        { text: '11:52 AM', confidence: 0.8 },
        { text: 'ok', confidence: 0.9 }
      ]
    }),
    null
  )
})
