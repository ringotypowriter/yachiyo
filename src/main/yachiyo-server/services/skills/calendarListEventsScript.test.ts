import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolve } from 'node:path'

const execFileAsync = promisify(execFile)

test('calendar_list_events AppleScript includes events overlapping the requested window', async () => {
  const scriptPath = resolve(
    process.cwd(),
    'resources/core-skills/yachiyo-macos-apps/scripts/calendar_list_events.py'
  )
  const command = [
    'import importlib.util, pathlib',
    `path = pathlib.Path(${JSON.stringify(scriptPath)})`,
    "spec = importlib.util.spec_from_file_location('calendar_list_events', path)",
    'module = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(module)',
    "print(module.build_applescript('2024-01-02 00:00:00', '2024-01-03 00:00:00', 'Work'))"
  ].join('; ')

  const { stdout } = await execFileAsync('python3', ['-c', command], {
    cwd: process.cwd()
  })

  assert.match(stdout, /end date >= date "2024-01-02 00:00:00"/)
  assert.match(stdout, /start date <= date "2024-01-03 00:00:00"/)
  assert.doesNotMatch(stdout, /start date >= date "2024-01-02 00:00:00"/)
})
