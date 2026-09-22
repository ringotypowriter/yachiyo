/* eslint-disable @typescript-eslint/explicit-function-return-type */
// Runs the iOS XCUITest smoke flow against the fake desktop, then captures themed screenshots.
//   node scripts/ios-ui-smoke.mjs [--skip-screenshots] [--min-ios 26] [--max-ios <major>]
// Picks the newest available iOS simulator runtime in range (26+ by default) and an iPhone on it. Screenshots go to
// apps/ios/Artifacts/ (git-ignored). Exits non-zero when the UI test fails.
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const iosDir = join(root, 'apps/ios')
const artifacts = join(iosDir, 'Artifacts')
const derivedData = join(
  process.env.HOME,
  'Library/Developer/Xcode/DerivedData/YachiyoRemote-smoke'
)
const bundleId = 'sh.ringo.yachiyo.remote'
const skipScreenshots = process.argv.includes('--skip-screenshots')
const flag = (name, fallback) => {
  const index = process.argv.indexOf(name)
  return index === -1 ? fallback : Number(process.argv[index + 1])
}
const minIos = flag('--min-ios', 26)
const maxIos = flag('--max-ios', Infinity)

const run = (command, args, options = {}) =>
  execFileSync(command, args, { stdio: 'inherit', ...options })
const output = (command, args) => execFileSync(command, args, { encoding: 'utf8' })
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))

function pickSimulator() {
  const { runtimes } = JSON.parse(output('xcrun', ['simctl', 'list', 'runtimes', '-j']))
  const candidates = runtimes
    .filter((runtime) => runtime.platform === 'iOS' && runtime.isAvailable)
    .filter((runtime) => {
      const major = Number(runtime.version.split('.')[0])
      return major >= minIos && major <= maxIos
    })
    .sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }))
  const { devices } = JSON.parse(output('xcrun', ['simctl', 'list', 'devices', 'available', '-j']))
  for (const runtime of candidates) {
    const phones = (devices[runtime.identifier] ?? []).filter((device) =>
      device.name.startsWith('iPhone')
    )
    const preferred = phones.find((device) => / Pro$/.test(device.name)) ?? phones[0]
    if (preferred) return { runtime: runtime.version, device: preferred }
  }
  throw new Error(`No iOS ${minIos}–${maxIos} iPhone simulator is available.`)
}

async function startHarness() {
  const urlFile = join(tmpdir(), `yachiyo-ui-smoke-${process.pid}.txt`)
  rmSync(urlFile, { force: true })
  const child = spawn(
    process.execPath,
    [
      '--experimental-strip-types',
      'scripts/remote-dev-harness.ts',
      '--port',
      '0',
      '--url-file',
      urlFile,
      '--slow-chunk-ms',
      '500'
    ],
    { cwd: root, stdio: ['pipe', 'ignore', 'inherit'] }
  )
  for (let attempt = 0; attempt < 60 && !existsSync(urlFile); attempt += 1) await sleep(500)
  if (!existsSync(urlFile)) throw new Error('Harness did not print a pairing URL.')
  return { url: readFileSync(urlFile, 'utf8').trim(), child }
}

const { runtime, device } = pickSimulator()
console.log(`Simulator: ${device.name} (iOS ${runtime}) ${device.udid}`)
const harness = await startHarness()
let failed = false
try {
  run('xcodegen', ['generate'], { cwd: iosDir })
  run('xcrun', ['simctl', 'boot', device.udid], { stdio: 'ignore' }) // already booted is fine
} catch {
  // simctl boot fails when the device is already booted.
}
try {
  run('xcrun', ['simctl', 'bootstatus', device.udid, '-b'])
  try {
    run('xcrun', ['simctl', 'uninstall', device.udid, bundleId])
  } catch {
    // Not installed yet.
  }
  const destination = `platform=iOS Simulator,id=${device.udid}`
  const common = [
    '-project',
    'YachiyoRemote.xcodeproj',
    '-scheme',
    'YachiyoRemote',
    '-destination',
    destination,
    '-derivedDataPath',
    derivedData
  ]
  run('xcodebuild', ['build-for-testing', ...common, '-quiet'], { cwd: iosDir })
  try {
    run('xcodebuild', ['test-without-building', ...common, '-only-testing:YachiyoRemoteUITests'], {
      cwd: iosDir,
      env: { ...process.env, TEST_RUNNER_YACHIYO_PAIRING_URL: harness.url }
    })
    console.log('XCUITest smoke flow passed')
  } catch {
    failed = true
    console.error('XCUITest smoke flow failed')
  }

  if (!skipScreenshots && !failed) {
    mkdirSync(artifacts, { recursive: true })
    for (const theme of ['mizu', 'gobyou', 'yamabuki']) {
      for (const appearance of ['light', 'dark']) {
        run('xcrun', ['simctl', 'ui', device.udid, 'appearance', appearance])
        for (const route of ['inbox', 'thread:demo-thread-coding-dispatch']) {
          try {
            run('xcrun', ['simctl', 'terminate', device.udid, bundleId], { stdio: 'ignore' })
          } catch {
            // Not running.
          }
          run(
            'xcrun',
            [
              'simctl',
              'launch',
              device.udid,
              bundleId,
              '-YachiyoThemeOverride',
              theme,
              '-YachiyoAppearanceOverride',
              appearance,
              '-YachiyoRoute',
              route
            ],
            { stdio: 'ignore' }
          )
          await sleep(route === 'inbox' ? 5000 : 7000)
          const file = join(
            artifacts,
            `${route === 'inbox' ? 'inbox' : 'thread'}-${theme}-${appearance}.png`
          )
          run('xcrun', ['simctl', 'io', device.udid, 'screenshot', file], { stdio: 'ignore' })
          console.log(`screenshot ${file}`)
        }
      }
    }
    run('xcrun', ['simctl', 'ui', device.udid, 'appearance', 'light'])
  }
} finally {
  harness.child.kill('SIGTERM')
}
process.exit(failed ? 1 : 0)
