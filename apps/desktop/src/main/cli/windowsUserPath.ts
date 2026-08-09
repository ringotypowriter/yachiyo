function normalizeWindowsPathEntry(value: string): string {
  return value
    .trim()
    .replace(/[\\/]+$/u, '')
    .toLocaleLowerCase('en-US')
}

export function addWindowsUserPathEntry(current: string, entry: string): string {
  const target = normalizeWindowsPathEntry(entry)
  const entries = current.split(';')
  if (entries.some((candidate) => normalizeWindowsPathEntry(candidate) === target)) {
    return current
  }
  if (!current) return entry
  return current.endsWith(';') ? `${current}${entry}` : `${current};${entry}`
}

export function removeWindowsUserPathEntry(current: string, entry: string): string {
  const target = normalizeWindowsPathEntry(entry)
  return current
    .split(';')
    .filter((candidate) => normalizeWindowsPathEntry(candidate) !== target)
    .join(';')
}

export interface WindowsUserPathStore {
  read(): string
  write(value: string): void
}

export function buildWindowsUserPathReadCommand(): string {
  return "[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); [Console]::Out.Write([Environment]::GetEnvironmentVariable('Path', 'User'))"
}

export function parseWindowsUserPathReadResult(result: {
  status: number | null
  stdout: string | Buffer | null
  stderr: string | Buffer | null
  error?: Error
}): string {
  const stderr = typeof result.stderr === 'string' ? result.stderr.trim() : ''
  if (result.error || result.status !== 0 || typeof result.stdout !== 'string') {
    const detail = result.error?.message || stderr
    throw new Error(`Could not read the Windows user PATH${detail ? `: ${detail}` : '.'}`)
  }
  return result.stdout.replace(/\r?\n$/u, '')
}

export function installWindowsUserPathEntry(entry: string, store: WindowsUserPathStore): boolean {
  const current = store.read()
  const updated = addWindowsUserPathEntry(current, entry)
  if (updated === current) return false
  store.write(updated)
  return true
}
