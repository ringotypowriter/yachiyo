/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { spawnSync } from 'node:child_process'
import process from 'node:process'
import { resolveBuildExecutables, resolveBuildSpawnSpec } from './build-executables.mjs'
import {
  ELECTRON_REBUILD_MODULES,
  buildRuntimeNativeModuleProbe
} from './runtime-native-modules.mjs'

const rootDir = process.cwd()
const executables = resolveBuildExecutables(process.platform, rootDir)
const electronBinPath = executables.electron
const pnpmBin = executables.pnpm

/** @type {(command: string, args: string[], env?: NodeJS.ProcessEnv) => import('node:child_process').SpawnSyncReturns<string>} */
const runCommand = (command, args, env = {}) => {
  const commandEnv = {
    ...process.env,
    ...env
  }
  const invocation = resolveBuildSpawnSpec(process.platform, command, args, commandEnv)
  const result = spawnSync(invocation.command, invocation.args, {
    ...invocation.options,
    cwd: rootDir,
    encoding: 'utf8',
    env: commandEnv
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
const verifyRuntimeNativeModules = () => {
  return (
    runCommand(electronBinPath, ['-e', buildRuntimeNativeModuleProbe()], {
      ELECTRON_RUN_AS_NODE: '1'
    }).status === 0
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

if (verifyRuntimeNativeModules()) {
  process.exit(0)
}

console.log(
  `native dependency check failed; rebuilding ${ELECTRON_REBUILD_MODULES.join(', ')} via electron-rebuild`
)

for (const packageName of ELECTRON_REBUILD_MODULES) {
  const rebuildResult = runCommand(pnpmBin, ['exec', 'electron-rebuild', '-f', '-w', packageName])
  if (rebuildResult.status !== 0) {
    console.error(`Failed to rebuild Electron native dependency ${packageName}`)
    process.exit(1)
  }
}

if (!verifyRuntimeNativeModules()) {
  console.error('Failed to prepare Electron runtime native dependencies')
  process.exit(1)
}
