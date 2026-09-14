import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { parseHTML } from 'linkedom'
import { YachiyoAvatar } from './YachiyoAvatar'
import { theme } from '../../theme/theme'

test('avatar keeps white eyes while its body follows the theme in live and export views', () => {
  for (const staticAvatar of [false, true]) {
    const avatar = renderAvatar(staticAvatar)
    assert.equal(avatar.style.getPropertyValue('--avatar-body'), theme.text.accent)
    assert.equal(avatar.style.getPropertyValue('--avatar-eyes'), '#fff')
    // html-to-image deep-clones SVG without copying descendants' stylesheet rules.
    for (const eye of avatar.querySelectorAll('.yachiyo-avatar__eye')) {
      assert.equal(eye.getAttribute('fill'), 'var(--avatar-eyes)')
    }
  }
})

function renderAvatar(staticAvatar: boolean): HTMLElement {
  const { document } = parseHTML(
    renderToStaticMarkup(
      <YachiyoAvatar static={staticAvatar} idleWink={false} size="conversation" />
    )
  )
  return document.querySelector('.yachiyo-avatar') as HTMLElement
}

test('export avatar stops motion without changing the canonical idle artwork or palette', () => {
  const live = renderAvatar(false)
  const exported = renderAvatar(true)
  assert.equal(exported.dataset.moving, 'false')
  assert.equal(exported.dataset.phase, live.dataset.phase)
  assert.equal(exported.getAttribute('style'), live.getAttribute('style'))
  assert.deepEqual(
    [...exported.querySelectorAll('circle,path')].map((element) => element.outerHTML),
    [...live.querySelectorAll('circle,path')].map((element) => element.outerHTML)
  )
  const filter = exported.querySelector('filter')!
  assert.ok(filter)
  assert.ok(
    exported.querySelector(`g[filter="url(#${filter.id})"]`),
    'Static rendering must retain the body-shaping filter'
  )
})
