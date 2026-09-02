import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const workflows = {
  changeset: readFileSync('.github/workflows/changeset.yml', 'utf8'),
  release: readFileSync('.github/workflows/release.yml', 'utf8'),
  nightly: readFileSync('.github/workflows/nightly.yml', 'utf8')
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
