import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ConversationAvatar } from './ConversationAvatar.tsx'

test('history initially hides the avatar without removing its placeholder', () => {
  const html = renderToStaticMarkup(React.createElement(ConversationAvatar))
  assert.match(html, /class="yachiyo-avatar"/)
  assert.match(html, /data-phase="idle"/)
  assert.match(html, /aria-hidden="true"/)
  assert.match(html, /data-moving="false"/, 'hidden history must not keep animations running')
})
