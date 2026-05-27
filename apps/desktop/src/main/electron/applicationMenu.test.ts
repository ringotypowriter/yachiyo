import assert from 'node:assert/strict'
import test from 'node:test'

import { createApplicationMenuTemplate } from './applicationMenu.ts'

function labels(items: Electron.MenuItemConstructorOptions[]): Array<string | undefined> {
  return items.map((item) => item.label)
}

test('createApplicationMenuTemplate exposes macOS Settings under the app menu', () => {
  const template = createApplicationMenuTemplate({
    appName: 'Yachiyo',
    isDev: false,
    platform: 'darwin',
    openSettings: () => {}
  })

  assert.equal(template[0]?.label, 'Yachiyo')
  const appSubmenu = template[0]?.submenu
  assert.ok(Array.isArray(appSubmenu))
  assert.deepEqual(appSubmenu[2], {
    label: 'Settings...',
    accelerator: 'Command+,',
    click: appSubmenu[2].click
  })
  assert.equal(typeof appSubmenu[2].click, 'function')
})

test('createApplicationMenuTemplate keeps standard macOS window commands', () => {
  const template = createApplicationMenuTemplate({
    appName: 'Yachiyo',
    isDev: false,
    platform: 'darwin',
    openSettings: () => {}
  })

  assert.deepEqual(labels(template), ['Yachiyo', 'File', 'Edit', 'View', 'Window', 'Help'])
  const fileSubmenu = template[1]?.submenu
  const windowSubmenu = template[4]?.submenu

  assert.ok(Array.isArray(fileSubmenu))
  assert.ok(Array.isArray(windowSubmenu))
  assert.deepEqual(fileSubmenu, [{ role: 'close' }])
  assert.deepEqual(windowSubmenu.slice(0, 3), [
    { role: 'minimize' },
    { role: 'zoom' },
    { type: 'separator' }
  ])
})

test('createApplicationMenuTemplate hides reload commands in production', () => {
  const template = createApplicationMenuTemplate({
    appName: 'Yachiyo',
    isDev: false,
    platform: 'darwin',
    openSettings: () => {}
  })

  const viewSubmenu = template[3]?.submenu
  assert.ok(Array.isArray(viewSubmenu))
  assert.equal(
    viewSubmenu.some((item) => item.role === 'reload'),
    false
  )
  assert.equal(
    viewSubmenu.some((item) => item.role === 'toggleDevTools'),
    false
  )
})

test('createApplicationMenuTemplate exposes Settings on non-mac platforms', () => {
  const template = createApplicationMenuTemplate({
    appName: 'Yachiyo',
    isDev: false,
    platform: 'win32',
    openSettings: () => {}
  })

  const fileSubmenu = template[0]?.submenu
  assert.ok(Array.isArray(fileSubmenu))
  assert.deepEqual(fileSubmenu[0], {
    label: 'Settings...',
    accelerator: 'Ctrl+,',
    click: fileSubmenu[0].click
  })
  assert.equal(typeof fileSubmenu[0].click, 'function')
})
