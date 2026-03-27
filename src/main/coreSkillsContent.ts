import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

function toShellPath(path: string): string {
  return path.replace(/\\/gu, '/')
}

export function rewriteBundledCoreSkillContent(content: string, targetRootPath: string): string {
  return content.replaceAll(
    'resources/core-skills/',
    `${toShellPath(targetRootPath).replace(/\/$/u, '')}/`
  )
}

export function rewriteBundledCoreSkillMarkdownFiles(targetRootPath: string): void {
  const stack = [targetRootPath]

  while (stack.length > 0) {
    const currentPath = stack.pop()
    if (!currentPath) continue

    for (const entry of readdirSync(currentPath, { withFileTypes: true })) {
      const entryPath = join(currentPath, entry.name)

      if (entry.isDirectory()) {
        stack.push(entryPath)
        continue
      }

      if (!entry.isFile() || !entry.name.endsWith('.md')) {
        continue
      }

      const original = readFileSync(entryPath, 'utf8')
      const rewritten = rewriteBundledCoreSkillContent(original, targetRootPath)

      if (rewritten !== original) {
        writeFileSync(entryPath, rewritten, 'utf8')
      }
    }
  }
}
