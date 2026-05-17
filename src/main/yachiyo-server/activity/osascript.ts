import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const OSA_SCRIPT_PATH = '/usr/bin/osascript'

export interface SampleWindowBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface SampleResult {
  appName: string
  bundleId: string
  windowTitle?: string
  windowBounds?: SampleWindowBounds
}

/**
 * Simple mode: only app name + bundle id. No accessibility permission needed.
 * Uses System Events `process` query (no AX API).
 */
async function sampleSimple(): Promise<SampleResult | null> {
  const script = `
ObjC.import('stdlib')
var se = Application('System Events')
var proc = se.processes.whose({ frontmost: true })[0]
if (!proc) { $.exit(1) }
JSON.stringify({ appName: proc.name(), bundleId: proc.bundleIdentifier() })
`.trim()

  try {
    const { stdout } = await execFileAsync(OSA_SCRIPT_PATH, ['-l', 'JavaScript', '-e', script], {
      timeout: 3000,
      encoding: 'utf8'
    })
    const trimmed = stdout.trim()
    if (!trimmed) return null

    const parsed = JSON.parse(trimmed)
    return {
      appName: parsed.appName || '',
      bundleId: parsed.bundleId || '',
      windowTitle: undefined
    }
  } catch {
    return null
  }
}

/**
 * Full mode: app name, bundle id, AND window title of frontmost window.
 * Needs accessibility permission. Returns null when the title cannot be read.
 */
async function sampleFull(): Promise<SampleResult | null> {
  const script = `
ObjC.import('stdlib')
var se = Application('System Events')
var proc = se.processes.whose({ frontmost: true })[0]
if (!proc) { $.exit(1) }
var win = proc.windows[0]
var payload = { appName: proc.name(), bundleId: proc.bundleIdentifier(), windowTitle: win.name() }
try {
  var position = win.position()
  var size = win.size()
  payload.windowBounds = { x: position[0], y: position[1], width: size[0], height: size[1] }
} catch (e) {}
JSON.stringify(payload)
`.trim()

  try {
    const { stdout } = await execFileAsync(OSA_SCRIPT_PATH, ['-l', 'JavaScript', '-e', script], {
      timeout: 3000,
      encoding: 'utf8'
    })
    const trimmed = stdout.trim()
    if (!trimmed) return null

    const parsed = JSON.parse(trimmed)
    return {
      appName: parsed.appName || '',
      bundleId: parsed.bundleId || '',
      windowTitle: parsed.windowTitle || undefined,
      windowBounds: parsed.windowBounds || undefined
    }
  } catch {
    return null
  }
}

export async function probeFullActivityAccess(): Promise<boolean> {
  const script = `
ObjC.import('stdlib')
var se = Application('System Events')
var proc = se.processes.whose({ frontmost: true })[0]
if (!proc) { $.exit(1) }
proc.windows[0].name()
true
`.trim()

  try {
    const { stdout } = await execFileAsync(OSA_SCRIPT_PATH, ['-l', 'JavaScript', '-e', script], {
      timeout: 3000,
      encoding: 'utf8'
    })
    return stdout.trim() === 'true'
  } catch {
    return false
  }
}

/**
 * Checks whether accessibility permission is currently granted
 * using the official AXIsProcessTrusted() API.
 */
export async function checkAccessibilityPermission(): Promise<boolean> {
  const script = `
ObjC.import('ApplicationServices')
$.AXIsProcessTrusted()
`.trim()

  try {
    const { stdout } = await execFileAsync(OSA_SCRIPT_PATH, ['-l', 'JavaScript', '-e', script], {
      timeout: 3000,
      encoding: 'utf8'
    })
    return stdout.trim() === 'true'
  } catch {
    return false
  }
}

/**
 * Sample current activity. Returns null on failure.
 * @param mode 'simple' (no permissions) or 'full' (with window titles)
 */
export async function sampleActivity(mode: 'simple' | 'full'): Promise<SampleResult | null> {
  if (mode === 'full') {
    return sampleFull()
  }
  return sampleSimple()
}
