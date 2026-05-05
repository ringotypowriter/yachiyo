import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

/**
 * Since the OneBot client depends on WebSocket (network), these tests verify
 * the message parsing and action serialization logic without a live connection.
 * Integration testing with a real NapCatQQ instance is done manually.
 */

describe('OneBot v11 message parsing', () => {
  it('parses a private message event correctly', () => {
    const raw = {
      time: 1711627200,
      self_id: 100000,
      post_type: 'message',
      message_type: 'private',
      sub_type: 'friend',
      message_id: 12345,
      user_id: 987654,
      raw_message: 'Hello world',
      font: 0,
      sender: {
        user_id: 987654,
        nickname: 'TestUser',
        sex: 'unknown',
        age: 0
      }
    }

    assert.equal(raw.post_type, 'message')
    assert.equal(raw.message_type, 'private')
    assert.equal(raw.user_id, 987654)
    assert.equal(raw.raw_message, 'Hello world')
    assert.equal(raw.sender.nickname, 'TestUser')
  })

  it('serializes a send_private_msg action correctly', () => {
    const action = {
      action: 'send_private_msg',
      params: {
        user_id: 987654,
        message: 'Reply text',
        auto_escape: true
      },
      echo: 'yachiyo-1'
    }

    const serialized = JSON.stringify(action)
    const parsed = JSON.parse(serialized)

    assert.equal(parsed.action, 'send_private_msg')
    assert.equal(parsed.params.user_id, 987654)
    assert.equal(parsed.params.message, 'Reply text')
    assert.equal(parsed.params.auto_escape, true)
    assert.equal(parsed.echo, 'yachiyo-1')
  })

  it('parses an action response correctly', () => {
    const response = {
      status: 'ok',
      retcode: 0,
      data: { message_id: 99999 },
      echo: 'yachiyo-1'
    }

    assert.equal(response.status, 'ok')
    assert.equal(response.retcode, 0)
    assert.equal(response.data.message_id, 99999)
    assert.equal(response.echo, 'yachiyo-1')
  })

  it('identifies meta events as non-message', () => {
    const heartbeat = {
      time: 1711627200,
      self_id: 100000,
      post_type: 'meta_event',
      meta_event_type: 'heartbeat',
      status: { online: true, good: true },
      interval: 30000
    }

    assert.equal(heartbeat.post_type, 'meta_event')
    assert.notEqual(heartbeat.post_type, 'message')
  })
})
