import assert from 'node:assert/strict'
import test from 'node:test'
import { createPluginCodec, type PluginPacket } from './pluginCodec.ts'

test('text references preserve user arrays, unusual keys and edited values', () => {
  const codec = createPluginCodec(true)
  const text = '项目🙂'.repeat(500)
  const original = {
    text,
    metadata: JSON.parse('{"__proto__":{"safe":true},"tag":["reference",0]}'),
    binary: new Uint8Array([0, 1, 255])
  }
  const input = codec.encode(original)
  const guestValue = codec.decode(input) as typeof original
  const changed = { ...guestValue, changedText: text + ':edited', omitted: undefined }
  assert.deepEqual(codec.decode(codec.encode(changed, input.strings), input.strings), {
    ...original,
    changedText: text + ':edited',
    omitted: undefined
  })
  assert.equal(Object.getPrototypeOf(guestValue.metadata), Object.prototype)
})

test('untrusted packets cannot read outside the current text table or evade expanded size limits', () => {
  const codec = createPluginCodec()
  const packet = (value: unknown): PluginPacket => ({
    json: JSON.stringify(value),
    buffers: [],
    strings: []
  })
  const text = 'x'.repeat(3 * 1024 * 1024)
  assert.equal(codec.decode(packet(['reference', 0]), [text]), text)
  for (const index of [-1, 1, 0.5, '__proto__']) {
    assert.throws(
      () => codec.decode(packet(['reference', index]), [text]),
      /Invalid plugin text reference/
    )
  }
  assert.throws(() => codec.decode(packet(['reference', 0])), /Invalid plugin text reference/)
  assert.throws(
    () => codec.decode(packet(['array', Array(3).fill(['reference', 0])]), [text]),
    /16 MiB/
  )
  assert.throws(
    () => codec.decode({ ...packet(['array', Array(3).fill(['string', 0])]), strings: [text] }),
    /16 MiB/
  )
})

test('repeated binary references are charged for every occurrence', () => {
  const codec = createPluginCodec()
  assert.throws(
    () =>
      codec.decode({
        json: JSON.stringify(['array', Array(3).fill(['buffer', 0])]),
        buffers: [new ArrayBuffer(6 * 1024 * 1024)],
        strings: []
      }),
    /16 MiB/
  )
})
