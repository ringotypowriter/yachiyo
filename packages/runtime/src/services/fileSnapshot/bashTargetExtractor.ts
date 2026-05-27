import { resolve } from 'node:path'

/**
 * Best-effort extraction of file paths that a bash command might write to.
 * This is intentionally imprecise — Layer 3 (post-run scan) catches what we miss.
 */
export function extractBashTargetFiles(command: string, cwd: string): string[] {
  const targets: string[] = []

  // Split by common command separators to handle chains
  const segments = command.split(/(?:\s*;\s*|\s*&&\s*|\s*\|\|\s*)/)

  for (const segment of segments) {
    targets.push(...extractFromSegment(segment.trim()))
  }

  // Also pick up absolute paths inside string literals (catches python -c
  // "open('/etc/hosts','w')" etc.). False positives are harmless because
  // finalize() skips unchanged files.
  const stringLiteralPaths = command.matchAll(/['"`](\/[^'"`]+)['"`]/g)
  for (const match of stringLiteralPaths) {
    const p = match[1]!
    if (p.includes('/') && !p.startsWith('/dev/')) {
      targets.push(p)
    }
  }

  // Resolve relative paths against cwd and deduplicate
  const resolved = new Set<string>()
  for (const target of targets) {
    const clean = target.replace(/^['"]|['"]$/g, '')
    if (clean && !clean.startsWith('/dev/')) {
      resolved.add(resolve(cwd, clean))
    }
  }

  return [...resolved]
}

function extractFromSegment(command: string): string[] {
  const targets: string[] = []

  // sed -i 's/foo/bar/' file.txt [file2.txt ...]
  const sedMatch = /\bsed\s+(?:-[^\s]*i[^\s]*\s+)?-i[^\s]*\s+(?:'[^']*'|"[^"]*"|\S+)\s+(.+)/i.exec(
    command
  )
  if (sedMatch) {
    const files = extractTrailingFiles(sedMatch[1]!)
    targets.push(...files)
  }

  // perl -pi -e '...' file.txt
  const perlMatch =
    /\bperl\s+(?:-[^\s]*i[^\s]*\s+)*-[^\s]*i[^\s]*\s+(?:-e\s+(?:'[^']*'|"[^"]*"|\S+)\s+)?(.+)/i.exec(
      command
    )
  if (perlMatch) {
    const files = extractTrailingFiles(perlMatch[1]!)
    targets.push(...files)
  }

  // Output redirects: > file, >> file
  const redirects = command.matchAll(/(?:^|[^>])\s*>>?\s*(\S+)/g)
  for (const match of redirects) {
    const target = match[1]!.replace(/^['"]|['"]$/g, '')
    if (target && target !== '/dev/null' && !target.startsWith('&')) {
      targets.push(target)
    }
  }

  // tee file [file2 ...]
  const teeMatch = /\btee\s+(?:-[a-z]+\s+)*(.+)/i.exec(command)
  if (teeMatch) {
    const files = extractTrailingFiles(teeMatch[1]!)
    targets.push(...files.filter((f) => !f.startsWith('-')))
  }

  // cp — last non-flag operand is the destination
  const cpMatch = /\bcp\s+(?:-[a-zA-Z]+\s+)*(.+)/i.exec(command)
  if (cpMatch) {
    const files = extractTrailingFiles(cpMatch[1]!)
    if (files.length > 0) targets.push(files.at(-1)!)
  }

  // mv — last non-flag operand is the destination
  const mvMatch = /\bmv\s+(?:-[a-zA-Z]+\s+)*(.+)/i.exec(command)
  if (mvMatch) {
    const files = extractTrailingFiles(mvMatch[1]!)
    if (files.length > 0) targets.push(files.at(-1)!)
  }

  // touch — all trailing non-flag operands are files
  const touchMatch = /\btouch\s+(?:-[a-zA-Z]+\s+)*(.+)/i.exec(command)
  if (touchMatch) {
    const files = extractTrailingFiles(touchMatch[1]!)
    targets.push(...files)
  }

  // rm — all trailing non-flag operands are files
  const rmMatch = /\brm\s+(?:-[a-zA-Z]+\s+)*(.+)/i.exec(command)
  if (rmMatch) {
    const files = extractTrailingFiles(rmMatch[1]!)
    targets.push(...files)
  }

  return targets
}

/** Extract file-like tokens from the end of a command fragment. */
function extractTrailingFiles(fragment: string): string[] {
  return fragment
    .split(/\s+/)
    .filter((t) => t.length > 0 && !t.startsWith('-') && !t.startsWith("'") && !t.startsWith('"'))
    .map((t) => t.replace(/^['"]|['"]$/g, ''))
}
