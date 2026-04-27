import assert from 'node:assert/strict'
import test from 'node:test'

import { splitTelegramMessage } from './telegramMessageSplit.ts'

test('splitTelegramMessage keeps every chunk inside the Telegram text limit', () => {
  const text = [
    'Took over:',
    '🛠️ Long context',
    '',
    '---',
    '',
    'Last recap:',
    'a'.repeat(2500),
    '',
    '---',
    '',
    'Since then:',
    'b'.repeat(2500)
  ].join('\n')

  const chunks = splitTelegramMessage(text)

  assert.equal(chunks.length, 2)
  assert.equal(chunks.join(''), text)
  assert.ok(chunks.every((chunk) => chunk.length <= 4096))
})
