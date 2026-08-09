import { app, Notification } from 'electron'
import { is } from '@electron-toolkit/utils'
import { t } from '@yachiyo/i18n/index'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { resolveYachiyoDataDir } from '@yachiyo/runtime/config/paths'
import {
  buildCLIWrapperContent,
  buildWindowsBashCLIWrapperContent,
  buildWindowsCLIUninstallScript,
  shellQuote
} from './cliWrapper.ts'
import {
  buildWindowsUserPathReadCommand,
  installWindowsUserPathEntry,
  parseWindowsUserPathReadResult
} from './windowsUserPath.ts'

const PATH_MARKER = '# Added by Yachiyo CLI'
const SYMLINK_TARGET = '/usr/local/bin/yachiyo'

export function resolveCLIBinDir(): string {
  return join(resolveYachiyoDataDir(), 'bin')
}

function resolveCLIWrapperPath(): string {
  return join(resolveCLIBinDir(), process.platform === 'win32' ? 'yachiyo.cmd' : 'yachiyo')
}

function resolveWindowsBashCLIWrapperPath(): string {
  return join(resolveCLIBinDir(), 'yachiyo')
}

function resolveCLIUninstallScriptPath(): string {
  return join(resolveCLIBinDir(), 'uninstall-cli.ps1')
}

function buildWrapperContent(): string {
  return buildCLIWrapperContent({
    platform: process.platform,
    developmentMode: is.dev,
    executablePath: process.execPath,
    appPath: app.getAppPath()
  })
}

function installWrapper(): void {
  const binDir = resolveCLIBinDir()
  const wrapperPath = resolveCLIWrapperPath()
  mkdirSync(binDir, { recursive: true })
  writeFileSync(wrapperPath, buildWrapperContent(), 'utf8')
  if (process.platform === 'win32') {
    const bashWrapperPath = resolveWindowsBashCLIWrapperPath()
    writeFileSync(
      bashWrapperPath,
      buildWindowsBashCLIWrapperContent({
        developmentMode: is.dev,
        executablePath: process.execPath,
        appPath: app.getAppPath()
      }),
      'utf8'
    )
    chmodSync(bashWrapperPath, 0o755)
  } else {
    chmodSync(wrapperPath, 0o755)
  }
}

function installWindowsCleanupScript(): void {
  writeFileSync(
    resolveCLIUninstallScriptPath(),
    buildWindowsCLIUninstallScript(resolveCLIBinDir()),
    'utf8'
  )
}

function isWrapperCurrent(): boolean {
  const wrapperPath = resolveCLIWrapperPath()
  if (!existsSync(wrapperPath)) return false
  try {
    if (readFileSync(wrapperPath, 'utf8') !== buildWrapperContent()) return false
    if (process.platform !== 'win32') return true
    return (
      readFileSync(resolveWindowsBashCLIWrapperPath(), 'utf8') ===
      buildWindowsBashCLIWrapperContent({
        developmentMode: is.dev,
        executablePath: process.execPath,
        appPath: app.getAppPath()
      })
    )
  } catch {
    return false
  }
}

/** Try to place a symlink at /usr/local/bin/yachiyo pointing to the wrapper. */
function trySymlink(): boolean {
  const wrapperPath = resolveCLIWrapperPath()
  try {
    if (existsSync(SYMLINK_TARGET)) {
      const stat = lstatSync(SYMLINK_TARGET)
      if (stat.isSymbolicLink()) {
        if (readlinkSync(SYMLINK_TARGET) === wrapperPath) return true
        unlinkSync(SYMLINK_TARGET)
      } else {
        // A non-symlink file exists — don't overwrite it
        return false
      }
    }
    mkdirSync(dirname(SYMLINK_TARGET), { recursive: true })
    symlinkSync(wrapperPath, SYMLINK_TARGET)
    return true
  } catch {
    return false
  }
}

function buildPosixPathLine(binDir: string): string {
  const home = homedir()
  const displayDir = binDir.startsWith(home + '/') ? '$HOME' + binDir.slice(home.length) : binDir
  return `export PATH="${displayDir}:$PATH"`
}

function buildFishPathLine(binDir: string): string {
  return `fish_add_path ${shellQuote(binDir)}`
}

function profileNeedsUpdate(
  profilePath: string,
  pathLine: string,
  createIfMissing: boolean
): boolean {
  if (!existsSync(profilePath)) return createIfMissing
  const content = readFileSync(profilePath, 'utf8')
  return !content.includes(PATH_MARKER) && !content.includes(pathLine)
}

function appendToProfile(profilePath: string, pathLine: string, createIfMissing = true): void {
  if (!profileNeedsUpdate(profilePath, pathLine, createIfMissing)) return
  mkdirSync(dirname(profilePath), { recursive: true })
  const existing = existsSync(profilePath) ? readFileSync(profilePath, 'utf8') : ''
  const separator = existing && !existing.endsWith('\n') ? '\n' : ''
  writeFileSync(profilePath, `${existing}${separator}${PATH_MARKER}\n${pathLine}\n`, 'utf8')
}

function ensurePathInShellProfiles(): void {
  const binDir = resolveCLIBinDir()
  const posixLine = buildPosixPathLine(binDir)
  const fishLine = buildFishPathLine(binDir)
  const home = homedir()

  const posixProfiles = [join(home, '.zshrc'), join(home, '.bashrc'), join(home, '.bash_profile')]

  for (const profilePath of posixProfiles) {
    try {
      appendToProfile(profilePath, posixLine)
    } catch (error) {
      console.warn(`[cli-setup] Could not update ${profilePath}:`, error)
    }
  }

  const fishConfig = join(home, '.config', 'fish', 'config.fish')
  const fishBinaryExists =
    existsSync('/opt/homebrew/bin/fish') ||
    existsSync('/usr/local/bin/fish') ||
    existsSync('/usr/bin/fish')
  try {
    appendToProfile(fishConfig, fishLine, fishBinaryExists)
  } catch (error) {
    console.warn(`[cli-setup] Could not update ${fishConfig}:`, error)
  }
}

function readWindowsUserPath(): string {
  return parseWindowsUserPathReadResult(
    spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', buildWindowsUserPathReadCommand()],
      { encoding: 'utf8', windowsHide: true }
    )
  )
}

function writeWindowsUserPath(value: string): void {
  const result = spawnSync(
    'reg.exe',
    ['add', 'HKCU\\Environment', '/v', 'Path', '/t', 'REG_EXPAND_SZ', '/d', value, '/f'],
    { encoding: 'utf8', windowsHide: true }
  )
  if (result.status !== 0) {
    const detail = typeof result.stderr === 'string' ? result.stderr.trim() : ''
    throw new Error(`Could not update the Windows user PATH${detail ? `: ${detail}` : '.'}`)
  }

  spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "$signature='[DllImport(\"user32.dll\", SetLastError=true, CharSet=CharSet.Auto)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd,uint Msg,UIntPtr wParam,string lParam,uint flags,uint timeout,out UIntPtr result);'; Add-Type -MemberDefinition $signature -Name NativeMethods -Namespace Yachiyo; $result=[UIntPtr]::Zero; [Yachiyo.NativeMethods]::SendMessageTimeout([IntPtr]0xffff,0x1a,[UIntPtr]::Zero,'Environment',2,5000,[ref]$result) | Out-Null"
    ],
    { encoding: 'utf8', windowsHide: true }
  )
}

function ensureWindowsUserPath(): void {
  installWindowsUserPathEntry(resolveCLIBinDir(), {
    read: readWindowsUserPath,
    write: writeWindowsUserPath
  })
}

function notifyCLIReady(symlinked: boolean): void {
  if (!Notification.isSupported()) return
  const body = symlinked ? t('main.cli.readySymlinked') : t('main.cli.readyRestart')
  new Notification({ title: t('main.cli.installedTitle'), body }).show()
}

export function setupCLI(): void {
  try {
    const wasAbsent = !existsSync(resolveCLIWrapperPath())

    if (!isWrapperCurrent()) {
      installWrapper()
      console.log(`[cli-setup] Installed yachiyo CLI at ${resolveCLIWrapperPath()}`)
    }

    if (process.platform === 'win32') {
      installWindowsCleanupScript()
      ensureWindowsUserPath()
      console.log('[cli-setup] Added the Yachiyo CLI directory to the Windows user PATH')
      if (wasAbsent) notifyCLIReady(false)
      return
    }

    const symlinked = trySymlink()
    if (symlinked) {
      console.log(`[cli-setup] Symlinked ${SYMLINK_TARGET} → ${resolveCLIWrapperPath()}`)
    } else {
      // Fallback: ensure shell profiles have the PATH entry
      ensurePathInShellProfiles()
      console.log('[cli-setup] Updated shell profiles with PATH entry')
    }

    if (wasAbsent) {
      notifyCLIReady(symlinked)
    }
  } catch (error) {
    console.error('[cli-setup] Setup failed:', error)
  }
}
