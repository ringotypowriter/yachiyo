import assert from 'node:assert/strict'
import test from 'node:test'

import { getMessageMarkdownAnimation } from './messageMarkdownAnimation.ts'

test('streaming markdown animates by character', () => {
  assert.deepEqual(getMessageMarkdownAnimation(true), {
    sep: 'char',
    animation: 'blurIn',
    duration: 110,
    easing: 'ease-out',
    stagger: 2
  })
})

test('static markdown disables animation', () => {
  assert.equal(getMessageMarkdownAnimation(false), false)
})
