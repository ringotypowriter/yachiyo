import assert from 'node:assert/strict'
import test from 'node:test'
import { RenderUiInputStream } from './renderUiInputStream.ts'

const source = {
  title: 'Calculator',
  css: 'body { color: red }',
  html: '<button>OK</button>',
  js: 'document.body.onclick = () => {}'
}

test('streams only decoded top-level fields across JSON escapes and surrogate chunk boundaries', () => {
  const parser = new RenderUiInputStream()
  const json = JSON.stringify({ ...source, html: '<b>😀</b>\n' }).replace('😀', '\\uD83D\\uDE00')
  let latest
  for (const char of json) latest = parser.append(char) ?? latest
  assert.deepEqual(latest, { kind: 'renderUi', ...source, html: '<b>😀</b>\n' })
})

test('never previews invalid syntax, unknown fields, oversize source or blank HTML', () => {
  const bad = [
    '{"title":"x","html":"<b>x</b>","other":"oops"}',
    '{"title":"x","html":"<b>x</b>","css":"' + 'x'.repeat(256 * 1024) + '"}',
    '{"title":"x","html":"   "}',
    '{"title":"x","html":"<b>x</b>","js":1}',
    '{"title":"x","html":"<b>x</b>",}',
    '{"title":"x","html":"<b>x</b>","css":"\\uD83D"}'
  ]
  for (const json of bad) {
    const parser = new RenderUiInputStream()
    const result = parser.append(json)
    assert.equal(result, undefined)
  }
})

test('does not retain or preview raw escaped input over a bounded limit', () => {
  const parser = new RenderUiInputStream()
  assert.equal(parser.append('{"html":"' + '\\u0061'.repeat(360_000)), undefined)
  assert.equal(parser.append('"}'), undefined)
})

test('cannot treat trailing invalid JSON as a valid preview', () => {
  const parser = new RenderUiInputStream()
  assert.equal(parser.append('{"title":"x","html":"<b>ok</b>","js":""} garbage'), undefined)
})
