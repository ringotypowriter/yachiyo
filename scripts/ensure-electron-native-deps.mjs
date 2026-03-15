import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'

const rootDir = process.cwd()
const packageJsonPath = resolve(rootDir, 'package.json')
const electronBinPath = resolve(rootDir, 'node_modules/.bin/electron')
const pnpmBin = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const electronVersion = JSON.parse(readFileSync(packageJsonPath, 'utf8')).devDependencies.electron
  ?.replace(/^[^\d]*/, '')

function runCommand(command, args, env = {}) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...env
    }
  })

  if (result.stdout) {
    process.stdout.write(result.stdout)
  }

  if (result.stderr) {
    process.stderr.write(result.stderr)
  }

  return result
}

function verifyBetterSqlite3() {
  return runCommand(
    electronBinPath,
    [
      '-e',
      [
        'try {',
        "  require('better-sqlite3')",
        "  console.log('native dependency check: better-sqlite3 ok')",
        '} catch (error) {',
        "  console.error(error instanceof Error ? error.stack : String(error))",
        '  process.exit(1)',
        '}'
      ].join('\n')
    ],
    {
      ELECTRON_RUN_AS_NODE: '1'
    }
  ).status === 0
}

function printAbiContext() {
  runCommand(process.execPath, ['-p', "'host node=' + process.version + ' modules=' + process.versions.modules"])
  runCommand(
    electronBinPath,
    [
      '-p',
      "'electron=' + process.versions.electron + ' node=' + process.versions.node + ' modules=' + process.versions.modules"
    ],
    {
      ELECTRON_RUN_AS_NODE: '1'
    }
  )
}

printAbiContext()

if (verifyBetterSqlite3()) {
  process.exit(0)
}

console.log('native dependency check failed; rebuilding for Electron via electron-builder')

const installAppDepsResult = runCommand(pnpmBin, ['exec', 'electron-builder', 'install-app-deps'])

if (installAppDepsResult.status === 0 && verifyBetterSqlite3()) {
  process.exit(0)
}

if (!electronVersion) {
  console.error('Unable to resolve Electron version from package.json')
  process.exit(1)
}

console.log(`electron-builder rebuild did not fix it; forcing better-sqlite3 rebuild for Electron ${electronVersion}`)

const rebuildResult = runCommand(
  pnpmBin,
  ['rebuild', 'better-sqlite3'],
  {
    npm_config_runtime: 'electron',
    npm_config_target: electronVersion,
    npm_config_disturl: 'https://electronjs.org/headers',
    npm_config_build_from_source: 'true'
  }
)

if (rebuildResult.status === 0 && verifyBetterSqlite3()) {
  process.exit(0)
}

console.error('Failed to prepare Electron native dependencies for better-sqlite3')
process.exit(1)
