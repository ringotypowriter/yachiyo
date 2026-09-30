import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'

const workflows = {
  changeset: readFileSync('.github/workflows/changeset.yml', 'utf8'),
  release: readFileSync('.github/workflows/release.yml', 'utf8'),
  nightly: readFileSync('.github/workflows/nightly.yml', 'utf8')
}

function getJob(workflow: string, name: string): string {
  const start = workflow.indexOf(`\n  ${name}:\n`)
  assert.notEqual(start, -1, `Missing job: ${name}`)
  return workflow.slice(start + 1).split(/\n {2}\w+:\n/u)[0]
}

function nightlyJobRuns(
  job: string,
  platform: string,
  event = 'workflow_dispatch',
  failedJob?: string
): boolean {
  const source = getJob(workflows.nightly, job)
  const expression = source.match(/ {4}if: (?:>-\n\s*)?\$\{\{([\s\S]*?)\}\}/u)?.[1]
  assert.ok(expression, `Missing condition for ${job}`)
  const needs = Object.fromEntries(
    ['version', 'release', 'build_macos', 'build_windows', 'build_linux'].map((name) => [
      name,
      { result: name === failedJob ? 'failure' : 'success' }
    ])
  )
  return runInNewContext(expression, {
    github: { event_name: event },
    inputs: { platform },
    needs,
    always: () => true
  }) as boolean
}

test('automatic stable macOS release uses the desktop build:mac package contract', () => {
  assert.match(workflows.changeset, /pnpm --filter @yachiyo\/desktop run build:mac/u)
  assert.doesNotMatch(workflows.changeset, /electron-builder[^\n]*--publish always/u)
})

test('stable release workflows explicitly prepare an idempotent GitHub Release before upload', () => {
  for (const name of ['changeset', 'release'] as const) {
    const workflow = workflows[name]
    const prepare = workflow.indexOf('github-release.mjs')
    const upload = workflow.indexOf('gh release upload')
    assert.notEqual(prepare, -1, `${name} must invoke the shared GitHub Release helper`)
    assert.notEqual(upload, -1, `${name} must upload updater artifacts`)
    assert.ok(prepare < upload, `${name} must ensure the GitHub Release before uploading artifacts`)
    assert.match(workflow, /apps\/desktop\/dist\/\*\.zip/u)
    assert.match(workflow, /apps\/desktop\/dist\/\*\.zip\.blockmap/u)
    assert.match(workflow, /apps\/desktop\/dist\/latest-mac\.yml/u)
  }
})

test('all release workflows use the shared subject-only release-notes helper', () => {
  for (const [name, workflow] of Object.entries(workflows)) {
    assert.match(workflow, /node [^\n]*github-release\.mjs/u, `${name} must use the helper`)
    assert.doesNotMatch(
      workflow,
      /git log[^\n]*--grep/u,
      `${name} must not duplicate git-log grep logic`
    )
  }
})

test('manual release loads release tooling independently of the target tag', () => {
  assert.match(
    workflows.release,
    /git show "origin\/\$\{\{ github\.event\.repository\.default_branch \}\}:scripts\/github-release\.mjs" > "\$RUNNER_TEMP\/github-release\.mjs"/u
  )
  assert.match(workflows.release, /node "\$RUNNER_TEMP\/github-release\.mjs" --tag/u)
})

test('every release workflow publishes and preserves the Linux update artifacts', () => {
  for (const [name, workflow] of Object.entries(workflows)) {
    const build = getJob(workflow, 'build_linux')
    assert.match(build, /runs-on: ubuntu-24\.04/u, name)
    assert.match(build, /pnpm --filter @yachiyo\/desktop run build:linux/u, name)
    assert.match(build, /gh release upload "\$RELEASE_TAG"/u, name)
    for (const artifact of ['*.AppImage', '*.deb', 'latest-linux.yml']) {
      assert.equal(
        build.split(`apps/desktop/dist/${artifact}`).length >= 3,
        true,
        `${name} must publish and preserve ${artifact}`
      )
    }
    assert.match(getJob(workflow, 'mirror'), /needs: \[[^\n]*build_linux\]/u, name)
  }
})

test('Linux stable uploads wait until the GitHub Release exists', () => {
  assert.match(getJob(workflows.release, 'build_linux'), /needs: build_macos/u)
  assert.match(getJob(workflows.changeset, 'build_linux'), /needs: \[version, build_macos\]/u)
  assert.match(
    getJob(workflows.changeset, 'build_linux'),
    /if: needs\.version\.outputs\.released == 'true'/u
  )
})

test('nightly defaults and schedules build every platform using a shared version', () => {
  assert.match(workflows.nightly, /default: all/u)
  for (const job of ['build_macos', 'build_windows', 'build_linux']) {
    assert.equal(nightlyJobRuns(job, 'all'), true, job)
    assert.equal(nightlyJobRuns(job, '', 'schedule'), true, job)
    assert.match(getJob(workflows.nightly, job), /pkg\.version = process\.env\.NIGHTLY_VERSION/u)
  }
  assert.match(workflows.nightly, /run\.event === 'schedule'/u)
})

test('nightly platform-only and legacy selections build only their requested platforms', () => {
  const selections: Record<string, string[]> = {
    linux: ['build_linux'],
    macos: ['build_macos'],
    windows: ['build_windows'],
    both: ['build_macos', 'build_windows']
  }
  for (const [platform, expected] of Object.entries(selections)) {
    for (const job of ['build_macos', 'build_windows', 'build_linux']) {
      assert.equal(nightlyJobRuns(job, platform), expected.includes(job), `${platform}: ${job}`)
    }
  }
})

test('nightly mirror waits for every selected platform and permits platform-only releases', () => {
  for (const platform of ['all', 'both', 'linux', 'macos', 'windows']) {
    assert.equal(nightlyJobRuns('mirror', platform), true, platform)
  }
  for (const failed of ['build_macos', 'build_windows', 'build_linux']) {
    assert.equal(nightlyJobRuns('mirror', 'all', 'workflow_dispatch', failed), false, failed)
    assert.equal(nightlyJobRuns('mirror', '', 'schedule', failed), false, failed)
  }
  assert.equal(nightlyJobRuns('mirror', 'linux', 'workflow_dispatch', 'build_linux'), false)
  assert.equal(nightlyJobRuns('mirror', 'linux', 'workflow_dispatch', 'build_macos'), true)
  assert.match(
    getJob(workflows.nightly, 'mirror'),
    /RELEASE_PLATFORM: \$\{\{ github\.event_name == 'schedule' && 'all' \|\| inputs\.platform \}\}/u
  )
})

test('Linux CI runs release regression tests and preserves its updater manifest', () => {
  const ci = getJob(readFileSync('.github/workflows/ci.yml', 'utf8'), 'linux')
  assert.match(ci, /scripts\/release-workflows\.test\.ts/u)
  assert.match(ci, /scripts\/sync-release-to-r2\.test\.ts/u)
  assert.match(ci, /apps\/desktop\/dist\/latest-linux\.yml/u)
})
