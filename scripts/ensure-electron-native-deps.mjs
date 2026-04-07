/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import process from 'node:process'

const rootDir = process.cwd()

const electronBinPath = resolve(rootDir, 'node_modules/.bin/electron')
const pnpmBin = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'

/** @type {(command: string, args: string[], env?: NodeJS.ProcessEnv) => import('node:child_process').SpawnSyncReturns<string>} */
const runCommand = (command, args, env = {}) => {
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

/** @type {() => boolean} */
const verifyBetterSqlite3 = () => {
  return (
    runCommand(
      electronBinPath,
      [
        '-e',
        [
          'try {',
          "  require('better-sqlite3')",
          "  console.log('native dependency check: better-sqlite3 ok')",
          '} catch (error) {',
          '  console.error(error instanceof Error ? error.stack : String(error))',
          '  process.exit(1)',
          '}'
        ].join('\n')
      ],
      {
        ELECTRON_RUN_AS_NODE: '1'
      }
    ).status === 0
  )
}

/** @type {() => void} */
const printAbiContext = () => {
  runCommand(process.execPath, [
    '-p',
    "'host node=' + process.version + ' modules=' + process.versions.modules"
  ])
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

console.log('native dependency check failed; rebuilding better-sqlite3 via electron-rebuild')

const rebuildResult = runCommand(pnpmBin, [
  'exec',
  'electron-rebuild',
  '-f',
  '-w',
  'better-sqlite3'
])

if (rebuildResult.status === 0 && verifyBetterSqlite3()) {
  process.exit(0)
}

console.error('Failed to prepare Electron native dependencies for better-sqlite3')
process.exit(1)
