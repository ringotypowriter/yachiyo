/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { posix, win32 } from 'node:path'

const CMD_META_CHARACTERS = /([()\][%!^"`<>&|;, *?])/g
const WINDOWS_CMD_SHIM = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/iu

function escapeWindowsCommand(command) {
  return command.replace(CMD_META_CHARACTERS, '^$1')
}

function escapeWindowsArgument(value, doubleEscapeMetaCharacters) {
  let argument = String(value)
  argument = argument.replace(/(?=(\\+?)?)\1"/gu, '$1$1\\"')
  argument = argument.replace(/(?=(\\+?)?)\1$/gu, '$1$1')
  argument = `"${argument}"`.replace(CMD_META_CHARACTERS, '^$1')
  return doubleEscapeMetaCharacters ? argument.replace(CMD_META_CHARACTERS, '^$1') : argument
}

export function resolveBuildExecutables(platform, repoRoot) {
  const path = platform === 'win32' ? win32 : posix
  const windows = platform === 'win32'
  return {
    electron: path.join(repoRoot, 'node_modules', '.bin', windows ? 'electron.cmd' : 'electron'),
    pnpm: windows ? 'pnpm.cmd' : 'pnpm',
    syncCore: windows ? 'sync-core.exe' : 'sync-core'
  }
}

export function resolveBuildSpawnSpec(platform, command, args, env = {}) {
  if (platform !== 'win32' || !command.toLowerCase().endsWith('.cmd')) {
    return { command, args: [...args], options: {} }
  }

  const normalizedCommand = win32.normalize(command)
  const doubleEscapeMetaCharacters = WINDOWS_CMD_SHIM.test(normalizedCommand)
  const shellCommand = [
    escapeWindowsCommand(normalizedCommand),
    ...args.map((argument) => escapeWindowsArgument(argument, doubleEscapeMetaCharacters))
  ].join(' ')
  const commandShell = Object.entries(env).find(
    ([name, value]) => name.toLowerCase() === 'comspec' && Boolean(value)
  )?.[1]

  return {
    command: commandShell ?? 'cmd.exe',
    args: ['/d', '/s', '/c', `"${shellCommand}"`],
    options: { windowsVerbatimArguments: true }
  }
}
