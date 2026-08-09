import assert from 'node:assert/strict'
import test from 'node:test'

import { resolvePython3Availability, type DoctorReport } from './doctor.ts'
import { runYachiyoCli } from '../yachiyoCli.ts'

const REPORT: DoctorReport = {
  platform: 'win32',
  arch: 'x64',
  commandEndpoint: '\\\\.\\pipe\\yachiyo-0123456789abcdef',
  shell: {
    kind: 'portable-git-bash',
    available: true,
    executable: 'C:\\Program Files\\Yachiyo\\resources\\bin\\bash\\usr\\bin\\bash.exe',
    version: '2.51.0'
  },
  binaries: { rg: true, fd: true, syncCore: true, python3: true },
  nativeModules: { betterSqlite3: true, sharp: true },
  capabilities: {
    activityTracking: false,
    activityOcr: false,
    macAutomationSkills: false
  }
}

test('doctor --json writes one valid JSON document and no GUI log noise', async () => {
  let stdout = ''
  let stderr = ''

  await runYachiyoCli(['doctor', '--json'], {
    collectDoctorReport: async () => REPORT,
    stdout: {
      write(chunk) {
        stdout += String(chunk)
        return true
      }
    },
    stderr: {
      write(chunk) {
        stderr += String(chunk)
        return true
      }
    }
  })

  assert.deepEqual(JSON.parse(stdout), REPORT)
  assert.equal(stdout.trim(), JSON.stringify(REPORT, null, 2))
  assert.equal(stderr, '')
})

test('doctor output cannot expose provider secrets, credential keys, auth files, or environment dumps', async () => {
  let stdout = ''
  const reportWithHostileExtras = {
    ...REPORT,
    apiKey: 'sk-do-not-print',
    environment: { OPENAI_API_KEY: 'sk-do-not-print' },
    credentialKey: 'private-key-material',
    authFile: '{"token":"secret-token"}'
  }

  await runYachiyoCli(['doctor', '--json'], {
    collectDoctorReport: async () => reportWithHostileExtras,
    stdout: {
      write(chunk) {
        stdout += String(chunk)
        return true
      }
    }
  })

  assert.deepEqual(JSON.parse(stdout), REPORT)
  assert.doesNotMatch(stdout, /sk-do-not-print|private-key-material|secret-token|OPENAI_API_KEY/u)
})

test('doctor text mode communicates the same platform conclusions', async () => {
  let stdout = ''

  await runYachiyoCli(['doctor'], {
    collectDoctorReport: async () => REPORT,
    stdout: {
      write(chunk) {
        stdout += String(chunk)
        return true
      }
    }
  })

  assert.match(stdout, /Windows.*x64/iu)
  assert.match(stdout, /PortableGit Bash.*available/iu)
  assert.match(stdout, /Python 3.*available/iu)
  assert.match(stdout, /Activity tracking.*unavailable/iu)
})

test('doctor explains how to repair a missing Windows Python dependency', async () => {
  let stdout = ''

  await runYachiyoCli(['doctor'], {
    collectDoctorReport: async () => ({
      ...REPORT,
      binaries: { ...REPORT.binaries, python3: false }
    }),
    stdout: {
      write(chunk) {
        stdout += String(chunk)
        return true
      }
    }
  })

  assert.match(stdout, /Python 3.*unavailable/iu)
  assert.match(stdout, /python\.org\/downloads\/windows/iu)
})

test('Python diagnosis matches the commands exposed by the Windows shim', () => {
  const attempts: Array<{ command: string; args: readonly string[] }> = []

  assert.equal(
    resolvePython3Availability({
      platform: 'win32',
      probe(command, args) {
        attempts.push({ command, args })
        return command === 'python.exe'
      }
    }),
    true
  )
  assert.deepEqual(
    attempts.map(({ command }) => command),
    ['py.exe', 'python.exe']
  )
  assert.equal(
    resolvePython3Availability({
      platform: 'win32',
      probe: () => false
    }),
    false
  )
})

test('Windows Store execution aliases do not count as an installed Python runtime', () => {
  const attempts: string[] = []
  assert.equal(
    resolvePython3Availability({
      platform: 'win32',
      probe: (command) => {
        attempts.push(command)
        return false
      }
    }),
    false
  )
  assert.deepEqual(attempts, ['py.exe', 'python.exe'])
})
