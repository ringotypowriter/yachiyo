import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { parseHTML } from 'linkedom'
import { detectLanguage } from '../lib/code-blocks/detectLanguage'
import { TextDocumentContent } from './DocumentReader'

test('source previews render highlighted tokens without changing file content or line breaks', () => {
  assert.equal(detectLanguage('/work/prompt.ts'), 'typescript')
  const content = 'export const answer = 42\n\n'
  const tokens = [
    [
      { content: 'export', lightColor: '#ff0000' },
      { content: ' const answer = 42', lightColor: '#0000ff' }
    ],
    [],
    []
  ]
  const { document } = parseHTML(
    renderToStaticMarkup(React.createElement(TextDocumentContent, { content, tokens }))
  )
  const preview = document.querySelector('.content-reader-text')!
  assert.equal(preview.textContent, content)
  assert.equal(preview.querySelectorAll('.yachiyo-code-token').length, 2)
  assert.match(preview.querySelector('.yachiyo-code-token')?.getAttribute('style') ?? '', /color/)
  const plain = parseHTML(
    renderToStaticMarkup(React.createElement(TextDocumentContent, { content, tokens: null }))
  ).document
  assert.equal(plain.querySelector('.content-reader-text')?.textContent, content)
  assert.equal(plain.querySelectorAll('.yachiyo-code-token').length, 0)
})
