/**
 * Parsing helpers for the electron-log main.log file format:
 * `[YYYY-MM-DD HH:mm:ss.SSS] [level] message`, where messages may span
 * multiple lines (continuation lines carry no header).
 */

export type AppLogLevel = 'error' | 'warn' | 'info' | 'verbose' | 'debug' | 'silly'

export interface AppLogEntry {
  timestamp: string
  level: AppLogLevel
  message: string
}

/** Result shape of the main-process `read-app-logs` IPC handler. */
export interface ReadAppLogsResult {
  entries: AppLogEntry[]
  /** Byte offset of the end of the last complete line in main.log. */
  cursor: number
  /** True when an incremental read fell back to a full read (file rotated). */
  reset: boolean
}

const LOG_LEVELS: readonly AppLogLevel[] = ['error', 'warn', 'info', 'verbose', 'debug', 'silly']

const HEADER_PATTERN = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})\] \[(\w+)\] ?(.*)$/

function normalizeLevel(raw: string): AppLogLevel {
  const level = raw.toLowerCase() as AppLogLevel
  return LOG_LEVELS.includes(level) ? level : 'info'
}

export function parseAppLogText(text: string): AppLogEntry[] {
  const entries: AppLogEntry[] = []
  for (const rawLine of text.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    const header = HEADER_PATTERN.exec(line)
    if (header) {
      entries.push({ timestamp: header[1], level: normalizeLevel(header[2]), message: header[3] })
      continue
    }
    if (line.trim() === '') continue
    const previous = entries[entries.length - 1]
    if (previous) {
      previous.message += `\n${line}`
    } else {
      // A rotated/truncated file can start mid-entry; keep the text visible.
      entries.push({ timestamp: '', level: 'info', message: line })
    }
  }
  return entries
}

export function formatAppLogTimestamp(date: Date): string {
  const pad = (value: number, width: number): string => String(value).padStart(width, '0')
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1, 2)}-${pad(date.getDate(), 2)}`
  const time = `${pad(date.getHours(), 2)}:${pad(date.getMinutes(), 2)}:${pad(date.getSeconds(), 2)}`
  return `${day} ${time}.${pad(date.getMilliseconds(), 3)}`
}

export interface LineSplitter {
  push: (chunk: string) => void
  flush: () => void
}

/**
 * Buffers stream chunks and emits complete, non-blank lines. Used to forward
 * child-process stdout/stderr into the logger one line at a time.
 */
export function createLineSplitter(onLine: (line: string) => void): LineSplitter {
  let buffered = ''
  const emit = (rawLine: string): void => {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (line.trim() === '') return
    onLine(line)
  }
  return {
    push: (chunk: string): void => {
      buffered += chunk
      const lines = buffered.split('\n')
      buffered = lines.pop() ?? ''
      for (const line of lines) emit(line)
    },
    flush: (): void => {
      if (buffered !== '') emit(buffered)
      buffered = ''
    }
  }
}
