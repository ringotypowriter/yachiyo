import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ToolCall } from '@renderer/app/types'
import { ShareToolView } from './ShareToolView'

const tool: ToolCall = {
  id: 'tool',
  threadId: 'thread',
  requestMessageId: 'question',
  toolName: 'read',
  inputSummary: 'Read file',
  status: 'completed',
  startedAt: '2026-01-01T00:00:00Z',
  rawInput: { path: '/private/file.txt' },
  rawOutput: 'private output\n'.repeat(1000)
}

test('compact tools omit raw payloads and never mount interactive controls', () => {
  const html = renderToStaticMarkup(
    React.createElement(ShareToolView, { toolCall: tool, details: false })
  )
  assert.doesNotMatch(html, /private output|\/private\/file|<button|<input|<details/)
  assert.match(html, /Read file/)
  assert.doesNotMatch(html, /Details omitted/)
})

test('expanded tools preserve complete output without truncation or scroll containers', () => {
  const html = renderToStaticMarkup(
    React.createElement(ShareToolView, { toolCall: tool, details: true })
  )
  assert.equal(html.split('private output').length - 1, 1000)
  assert.match(html, /\/private\/file.txt/)
  assert.doesNotMatch(html, /max-height|overflow-auto|<button|<input/)
})

test('askUser remains static and shows its stored question even in compact mode', () => {
  const html = renderToStaticMarkup(
    React.createElement(ShareToolView, {
      toolCall: {
        ...tool,
        toolName: 'askUser',
        rawInput: { question: 'Continue?', choices: ['Yes', 'No'] },
        rawOutput: { answer: 'Yes' }
      },
      details: false
    })
  )
  assert.match(html, /Continue\?/)
  assert.match(html, /Yes/)
  assert.doesNotMatch(html, /<pre|Details omitted|Output|Input/)
  assert.doesNotMatch(html, /<button|<input|<select/)
})

test('compact tools include their output summary', () => {
  const html = renderToStaticMarkup(
    React.createElement(ShareToolView, {
      toolCall: { ...tool, outputSummary: 'Read 24 lines' },
      details: false
    })
  )
  assert.match(html, /Read 24 lines/)
  assert.doesNotMatch(html, /private output/)
})

test('details omit recognized binary payloads without shortening meaningful text', () => {
  const meaningful = 'A meaningful sentence. '.repeat(200)
  const html = renderToStaticMarkup(
    React.createElement(ShareToolView, {
      toolCall: {
        ...tool,
        rawInput: { imageBase64: 'SECRETINPUT' },
        rawOutput: {
          blocks: [
            { type: 'image', mimeType: 'image/png', data: 'SECRETBINARY' },
            { type: 'text', text: meaningful }
          ],
          thumbnail: 'data:image/png;base64,U0VDUkVU',
          buffer: { type: 'Buffer', data: [10, 20, 30] }
        }
      },
      details: true
    })
  )
  assert.doesNotMatch(html, /SECRETINPUT|SECRETBINARY|U0VDUkVU|data:image/)
  assert.match(html, /Binary payload omitted/)
  assert.equal(html.split('A meaningful sentence.').length - 1, 200)
})

test('compact tools do not repeat identical input and output summaries', () => {
  const html = renderToStaticMarkup(
    React.createElement(ShareToolView, {
      toolCall: { ...tool, inputSummary: 'Read 24 lines', outputSummary: 'Read 24 lines' },
      details: false
    })
  )
  assert.equal(html.split('Read 24 lines').length - 1, 1)
})
