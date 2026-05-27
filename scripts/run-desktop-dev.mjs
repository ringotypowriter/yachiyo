#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const desktopDir = resolve(repoRoot, 'apps', 'desktop')
const args = new Set(process.argv.slice(2))

const devEnv = { ...process.env }
if (args.has('--channels')) {
  devEnv.YACHIYO_DEV_CHANNELS = '1'
}
if (args.has('--schedules')) {
  devEnv.YACHIYO_DEV_SCHEDULES = '1'
}

let activeChild = undefined
let receivedSignal = false
let terminalReset = false

function resetTerminal() {
  if (terminalReset) {
    return
  }
  terminalReset = true

  if (process.stdout.isTTY) {
    // Disable common mouse reporting modes before the full reset. If Electron/Vite
    // exits mid-frame, fish can otherwise print raw mouse event escape sequences.
    process.stdout.write('\u001b[?1000l\u001b[?1002l\u001b[?1003l\u001b[?1006l')
  }

  spawnSync('tput', ['reset'], { stdio: 'ignore' })
}

function run(command, commandArgs, options = {}) {
  return new Promise((resolveExit) => {
    activeChild = spawn(command, commandArgs, {
      cwd: desktopDir,
      env: options.env ?? process.env,
      stdio: 'inherit'
    })

    activeChild.on('close', (code, signal) => {
      activeChild = undefined
      resolveExit({ code, signal })
    })
  })
}

function handleSignal(signal) {
  receivedSignal = true
  if (activeChild && !activeChild.killed) {
    activeChild.kill(signal)
  } else {
    resetTerminal()
    process.exit(0)
  }
}

process.once('SIGINT', () => handleSignal('SIGINT'))
process.once('SIGTERM', () => handleSignal('SIGTERM'))
process.once('exit', resetTerminal)

const nativePrepare = await run(process.execPath, [
  resolve(repoRoot, 'scripts/ensure-electron-native-deps.mjs')
])
if (nativePrepare.code !== 0 || nativePrepare.signal) {
  resetTerminal()
  process.exit(nativePrepare.code ?? 1)
}

const electronViteBin = resolve(
  desktopDir,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'electron-vite.cmd' : 'electron-vite'
)
const electronViteCommand = existsSync(electronViteBin) ? electronViteBin : 'electron-vite'
const devResult = await run(electronViteCommand, ['dev'], { env: devEnv })

resetTerminal()
if (receivedSignal || devResult.signal === 'SIGINT' || devResult.signal === 'SIGTERM') {
  process.exit(0)
}
process.exit(devResult.code ?? 1)
