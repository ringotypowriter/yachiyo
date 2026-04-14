import { resolve } from 'node:path'

/**
 * Best-effort extraction of file paths that a bash command might write to.
 * This is intentionally imprecise — Layer 3 (post-run scan) catches what we miss.
 */
export function extractBashTargetFiles(command: string, cwd: string): string[] {
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

/** Extract file-like tokens from the end of a command fragment. */
function extractTrailingFiles(fragment: string): string[] {
  return fragment
    .split(/\s+/)
    .filter((t) => t.length > 0 && !t.startsWith('-') && !t.startsWith("'") && !t.startsWith('"'))
    .map((t) => t.replace(/^['"]|['"]$/g, ''))
}
