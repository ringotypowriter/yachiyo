import test from 'node:test'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { Buffer } from 'node:buffer'

const rootDir = process.cwd()
const isCI = !!process.env.CI

async function runCommandJson(scriptPath: string, args: string[]): Promise<unknown> {
  const output = await new Promise<string>((resolveOutput, reject) => {
    const child = spawn('python3', [scriptPath, ...args], {
      cwd: rootDir,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''

    const timeout = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error(`script timed out after 20s: ${scriptPath}`))
    }, 20000)

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (err) => {
      clearTimeout(timeout)
      reject(err)
    })
    child.on('close', (code) => {
      clearTimeout(timeout)
      if (code !== 0) {
        reject(new Error(`script failed (${code}): ${stderr || stdout}`))
        return
      }
      resolveOutput(stdout)
    })
  })

  return JSON.parse(output)
}

test('macos-apps scripts are executable and accept --help', async () => {
  const scripts = [
    'resources/core-skills/yachiyo-macos-apps/scripts/mail_compose.py',
    'resources/core-skills/yachiyo-macos-apps/scripts/mail_list.py',
    'resources/core-skills/yachiyo-macos-apps/scripts/notes_create.py',
    'resources/core-skills/yachiyo-macos-apps/scripts/notes_search.py',
    'resources/core-skills/yachiyo-macos-apps/scripts/reminders_list_lists.py',
    'resources/core-skills/yachiyo-macos-apps/scripts/reminders_create.py',
    'resources/core-skills/yachiyo-macos-apps/scripts/reminders_list.py',
    'resources/core-skills/yachiyo-macos-apps/scripts/calendar_list_calendars.py',
    'resources/core-skills/yachiyo-macos-apps/scripts/calendar_create_event.py',
    'resources/core-skills/yachiyo-macos-apps/scripts/calendar_list_events.py'
  ]

  for (const script of scripts) {
    const output = await new Promise<string>((resolveOutput, reject) => {
      const child = spawn('python3', [resolve(rootDir, script), '--help'], {
        cwd: rootDir,
        stdio: ['ignore', 'pipe', 'pipe']
      })
      let stdout = ''
      let stderr = ''

      const timeout = setTimeout(() => {
        child.kill('SIGTERM')
        reject(new Error(`help timed out after 20s: ${script}`))
      }, 20000)

      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8')
      })
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8')
      })
      child.on('error', (err) => {
        clearTimeout(timeout)
        reject(err)
      })
      child.on('close', (code) => {
        clearTimeout(timeout)
        if (code !== 0) {
          reject(new Error(`help failed for ${script} (${code}): ${stderr || stdout}`))
          return
        }
        resolveOutput(stdout)
      })
    })
    assert.ok(output.toLowerCase().includes('usage'), `expected usage in --help for ${script}`)
  }
})

test('macos-apps mail_compose.py produces JSON draft without sending', { skip: isCI }, async () => {
  const report = (await runCommandJson(
    resolve(rootDir, 'resources/core-skills/yachiyo-macos-apps/scripts/mail_compose.py'),
    ['--to', 'test@example.com', '--subject', 'Test', '--body', 'Body', '--json']
  )) as {
    success: boolean
    send: boolean
  }
  assert.equal(report.send, false)
  assert.equal(report.success, true)
})

test('macos-apps notes_search.py produces valid JSON', { skip: isCI }, async () => {
  const report = (await runCommandJson(
    resolve(rootDir, 'resources/core-skills/yachiyo-macos-apps/scripts/notes_search.py'),
    ['--query', 'test', '--json']
  )) as Record<string, unknown>
  assert.equal(report.success, true)
  assert.ok('notes' in report)
})

test('macos-apps reminders_list_lists.py produces valid JSON', { skip: isCI }, async () => {
  const report = (await runCommandJson(
    resolve(rootDir, 'resources/core-skills/yachiyo-macos-apps/scripts/reminders_list_lists.py'),
    ['--json']
  )) as Record<string, unknown>
  assert.equal(report.success, true)
  assert.ok('lists' in report)
})

test('macos-apps reminders_list.py produces valid JSON', { skip: isCI }, async () => {
  const report = (await runCommandJson(
    resolve(rootDir, 'resources/core-skills/yachiyo-macos-apps/scripts/reminders_list.py'),
    ['--json']
  )) as Record<string, unknown>
  assert.equal(report.success, true)
  assert.ok('reminders' in report)
})

test('macos-apps calendar_list_calendars.py produces valid JSON', { skip: isCI }, async () => {
  const report = (await runCommandJson(
    resolve(rootDir, 'resources/core-skills/yachiyo-macos-apps/scripts/calendar_list_calendars.py'),
    ['--json']
  )) as Record<string, unknown>
  assert.equal(report.success, true)
  assert.ok('calendars' in report)
})

test('macos-apps calendar_list_events.py produces valid JSON', { skip: isCI }, async () => {
  // List calendars and pick the first one so the date-range query stays fast
  const calendarsReport = (await runCommandJson(
    resolve(rootDir, 'resources/core-skills/yachiyo-macos-apps/scripts/calendar_list_calendars.py'),
    ['--json']
  )) as { calendars: string[] }
  assert.ok(calendarsReport.calendars.length > 0, 'expected at least one calendar')
  const firstCalendar = calendarsReport.calendars[0] as string

  const report = (await runCommandJson(
    resolve(rootDir, 'resources/core-skills/yachiyo-macos-apps/scripts/calendar_list_events.py'),
    [
      '--from-date',
      '2024-01-01 00:00:00',
      '--to-date',
      '2024-01-02 00:00:00',
      '--calendar',
      firstCalendar,
      '--json'
    ]
  )) as Record<string, unknown>
  assert.equal(report.success, true)
  assert.ok('events' in report)
})
