import assert from 'node:assert/strict'
import test from 'node:test'
import { formatDiscordGroupText } from './discordService.ts'

test('Discord group context fetches an explicit reply without treating it as a mention', async () => {
  assert.equal(
    await formatDiscordGroupText({
      content: 'thoughts?',
      reference: { messageId: 'quoted' },
      fetchReference: async () => ({ author: { username: 'Alice' }, content: 'the proposal' })
    } as never),
    '[Reply to Alice: the proposal]\nthoughts?'
  )
})

test('Discord still handles the request if the referenced message is unavailable', async () => {
  assert.equal(
    await formatDiscordGroupText({
      content: 'thoughts?',
      reference: { messageId: 'deleted' },
      fetchReference: async () => {
        throw new Error('deleted')
      }
    } as never),
    'thoughts?'
  )
})
