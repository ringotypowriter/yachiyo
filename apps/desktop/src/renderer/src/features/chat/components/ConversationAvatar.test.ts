import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ConversationAvatar } from './ConversationAvatar.tsx'

test('the conversation keeps an avatar even without an active run', () => {
  const html = renderToStaticMarkup(React.createElement(ConversationAvatar))
  assert.match(html, /class="yachiyo-avatar"/)
  assert.match(html, /data-phase="idle"/)
})
