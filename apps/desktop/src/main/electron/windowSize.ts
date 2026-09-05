import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

interface WindowSize {
  width: number
  height: number
}

export const MAIN_WINDOW_SIZE_LIMITS = { minWidth: 760, minHeight: 500 }
const DEFAULT_SIZE: WindowSize = { width: 1280, height: 820 }

function validSize(value: unknown): value is WindowSize {
  if (!value || typeof value !== 'object') return false
  const { width, height } = value as WindowSize
  return Number.isSafeInteger(width) && width > 0 && Number.isSafeInteger(height) && height > 0
}

export function loadMainWindowSize(path: string, workArea: WindowSize): WindowSize {
  let size = DEFAULT_SIZE
  try {
    const saved: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (validSize(saved)) size = saved
  } catch {
    // Missing or damaged local state must never prevent opening the main window.
  }
  return {
    width: Math.max(MAIN_WINDOW_SIZE_LIMITS.minWidth, Math.min(size.width, workArea.width)),
    height: Math.max(MAIN_WINDOW_SIZE_LIMITS.minHeight, Math.min(size.height, workArea.height))
  }
}

export function trackMainWindowSize(
  window: {
    getNormalBounds(): WindowSize
    on(event: 'resized' | 'close', listener: () => void): unknown
  },
  path: string
): void {
  const save = (): void => {
    try {
      const { width, height } = window.getNormalBounds()
      if (!validSize({ width, height })) return
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, JSON.stringify({ width, height }) + '\n', 'utf8')
    } catch (error) {
      console.warn('[window-size] Could not save main window dimensions', error)
    }
  }
  window.on('resized', save)
  window.on('close', save)
}
