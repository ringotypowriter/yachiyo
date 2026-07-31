import assert from 'node:assert/strict'
import test from 'node:test'

import { buildCLIWrapperContent } from './cliWrapper.ts'

test('development CLI wrapper starts the Electron main process in headless CLI mode', () => {
  const wrapper = buildCLIWrapperContent({
    developmentMode: true,
    executablePath: "/Applications/Electron's.app/Contents/MacOS/Electron",
    appPath: '/workspace/yachiyo/apps/desktop'
  })

  assert.match(wrapper, /--yachiyo-cli "\$@"/u)
  assert.match(wrapper, /\/workspace\/yachiyo\/apps\/desktop/u)
  assert.doesNotMatch(wrapper, /ELECTRON_RUN_AS_NODE/u)
})

test('packaged CLI wrapper starts the application executable in headless CLI mode', () => {
  const wrapper = buildCLIWrapperContent({
    developmentMode: false,
    executablePath: '/Applications/Yachiyo.app/Contents/MacOS/Yachiyo',
    appPath: '/Applications/Yachiyo.app/Contents/Resources/app.asar'
  })

  assert.match(wrapper, /--yachiyo-cli "\$@"/u)
  assert.doesNotMatch(wrapper, /app\.asar/u)
  assert.doesNotMatch(wrapper, /ELECTRON_RUN_AS_NODE/u)
})
