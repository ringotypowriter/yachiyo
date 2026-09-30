import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  buildCLIWrapperContent,
  buildWindowsBashCLIWrapperContent,
  buildWindowsCLIUninstallScript
} from './cliWrapper.ts'

test('development CLI wrapper starts the Electron main process in headless CLI mode', () => {
  const wrapper = buildCLIWrapperContent({
    platform: 'darwin',
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
    platform: 'darwin',
    developmentMode: false,
    executablePath: '/Applications/Yachiyo.app/Contents/MacOS/Yachiyo',
    appPath: '/Applications/Yachiyo.app/Contents/Resources/app.asar'
  })

  assert.match(wrapper, /--yachiyo-cli "\$@"/u)
  assert.doesNotMatch(wrapper, /app\.asar/u)
  assert.doesNotMatch(wrapper, /ELECTRON_RUN_AS_NODE/u)
})

test('packaged Linux CLI wrapper uses the persistent AppImage path', () => {
  const wrapper = buildCLIWrapperContent({
    platform: 'linux',
    developmentMode: false,
    executablePath: '/tmp/.mount_Yachiyo123/yachiyo',
    appImagePath: '/home/user/Applications/Yachiyo.AppImage',
    appPath: '/tmp/.mount_Yachiyo123/resources/app.asar'
  })

  assert.match(
    wrapper,
    /^exec '\/home\/user\/Applications\/Yachiyo.AppImage' --yachiyo-cli "\$@"$/mu
  )
  assert.doesNotMatch(wrapper, /\.mount_|app\.asar/u)
})

test('packaged Linux CLI wrapper falls back to the installed executable outside AppImage', () => {
  for (const appImagePath of [undefined, '']) {
    const wrapper = buildCLIWrapperContent({
      platform: 'linux',
      developmentMode: false,
      executablePath: '/opt/Yachiyo/yachiyo',
      appImagePath,
      appPath: '/opt/Yachiyo/resources/app.asar'
    })

    assert.match(wrapper, /^exec '\/opt\/Yachiyo\/yachiyo' --yachiyo-cli "\$@"$/mu)
    assert.doesNotMatch(wrapper, /app\.asar/u)
  }
})

test('AppImage paths are ignored during development and on other platforms', () => {
  for (const platform of ['linux', 'darwin', 'win32'] as const) {
    for (const developmentMode of [true, false]) {
      if (platform === 'linux' && !developmentMode) continue
      const input = {
        platform,
        developmentMode,
        executablePath: '/installed/yachiyo',
        appPath: '/workspace/yachiyo/apps/desktop'
      }

      assert.equal(
        buildCLIWrapperContent({ ...input, appImagePath: '/unrelated/Yachiyo.AppImage' }),
        buildCLIWrapperContent(input)
      )
    }
  }
})

test(
  'AppImage wrapper safely quotes paths and preserves arguments and exit status',
  { skip: process.platform === 'win32' },
  (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'yachiyo-cli-'))
    t.after(() => rmSync(directory, { recursive: true, force: true }))
    const appImagePath = join(directory, 'Yachiyo\'s "release" $(ignored).AppImage')
    writeFileSync(appImagePath, '#!/bin/sh\nprintf "%s\\n" "$0" "$@"\nexit 23\n', {
      mode: 0o755
    })
    const wrapper = buildCLIWrapperContent({
      platform: 'linux',
      developmentMode: false,
      executablePath: '/tmp/.mount_Yachiyo123/yachiyo',
      appImagePath,
      appPath: '/tmp/.mount_Yachiyo123/resources/app.asar'
    })
    const args = ['chat', 'two words', '', 'a\'b"c', '$HOME', '$(ignored)']
    const result = spawnSync('bash', ['-c', wrapper, 'yachiyo', ...args], { encoding: 'utf8' })

    assert.ifError(result.error)
    assert.equal(result.status, 23)
    assert.equal(result.stderr, '')
    assert.equal(result.stdout, [appImagePath, '--yachiyo-cli', ...args, ''].join('\n'))
  }
)

test('Windows CLI wrapper preserves arguments and the Electron CLI exit code', () => {
  const wrapper = buildCLIWrapperContent({
    platform: 'win32',
    developmentMode: false,
    executablePath: 'C:\\Program Files (x86)\\Yachiyo & Friends\\yachiyo.exe',
    appPath: 'C:\\Program Files (x86)\\Yachiyo & Friends\\resources\\app.asar'
  })

  assert.match(wrapper, /^@echo off\r?$/mu)
  assert.match(
    wrapper,
    /"C:\\Program Files \(x86\)\\Yachiyo & Friends\\yachiyo\.exe" --yachiyo-cli %\*/u
  )
  assert.match(wrapper, /exit \/b %errorlevel%/iu)
  assert.doesNotMatch(wrapper, /app\.asar/u)
})

test('development Windows CLI wrapper quotes both executable and app paths', () => {
  const wrapper = buildCLIWrapperContent({
    platform: 'win32',
    developmentMode: true,
    executablePath: 'C:\\source tree\\node_modules\\electron\\dist\\electron.exe',
    appPath: 'C:\\source tree\\yachiyo\\apps\\desktop'
  })

  assert.match(wrapper, /"C:\\source tree\\node_modules\\electron\\dist\\electron\.exe"/u)
  assert.match(wrapper, /"C:\\source tree\\yachiyo\\apps\\desktop" --yachiyo-cli %\*/u)
})

test('Windows also generates an extensionless wrapper for bundled Bash', () => {
  const wrapper = buildWindowsBashCLIWrapperContent({
    developmentMode: false,
    executablePath: 'C:\\Program Files (x86)\\Yachiyo & Friends\\yachiyo.exe',
    appPath: 'C:\\Program Files (x86)\\Yachiyo & Friends\\resources\\app.asar'
  })

  assert.match(wrapper, /^#!\/usr\/bin\/env bash$/mu)
  assert.match(
    wrapper,
    /cygpath -u -- 'C:\\Program Files \(x86\)\\Yachiyo & Friends\\yachiyo\.exe'/u
  )
  assert.match(wrapper, /--yachiyo-cli "\$@"/u)
  assert.match(wrapper, /^exec /mu)
})

test('Windows CLI uninstall cleanup removes only the generated wrapper and matching PATH entry', () => {
  const script = buildWindowsCLIUninstallScript("C:\\Users\\Ringo's Laptop\\.yachiyo\\bin")

  assert.match(script, /GetEnvironmentVariable\('Path', 'User'\)/u)
  assert.match(script, /SetEnvironmentVariable\('Path', \$updated, 'User'\)/u)
  assert.match(script, /yachiyo\.cmd/u)
  assert.match(script, /Join-Path \$target 'yachiyo'/u)
  assert.match(script, /Ringo''s Laptop/u)
  assert.doesNotMatch(script, /Remove-Item[^\n]+\.yachiyo[^\n]+-Recurse/iu)
})
