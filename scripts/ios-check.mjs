/* eslint-disable @typescript-eslint/explicit-function-return-type */
// Liquid Glass branching stays in two places so the iOS 17–25 fallback is reviewable in one spot:
// the YachiyoMaterial module and the forked ChatInputView. Any other `#available(iOS 26` or
// `@available(iOS 26` fails this check.
import { readdir, readFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const iosRoot = resolve(root, 'apps/ios')
const ALLOWED = [
  'apps/ios/YachiyoChatUI/Sources/YachiyoMaterial/',
  'apps/ios/YachiyoChatUI/Sources/YachiyoChatUI/View/ChatInput/ChatInputView.swift'
]
const PATTERN = /[#@]available\s*\(\s*iOS\s+26\b/

async function swiftFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    if (['.build', '.swiftpm', 'DerivedData', 'YachiyoRemote.xcodeproj'].includes(entry.name))
      continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...(await swiftFiles(path)))
    else if (entry.name.endsWith('.swift')) files.push(path)
  }
  return files
}

const violations = []
for (const file of await swiftFiles(iosRoot)) {
  const path = relative(root, file)
  if (ALLOWED.some((allowed) => path === allowed || path.startsWith(allowed))) continue
  const lines = (await readFile(file, 'utf8')).split('\n')
  lines.forEach((line, index) => {
    if (PATTERN.test(line)) violations.push(`${path}:${index + 1}: ${line.trim()}`)
  })
}

if (violations.length > 0) {
  console.error(
    'iOS 26 availability checks belong in YachiyoMaterial (or the forked ChatInputView):'
  )
  for (const violation of violations) console.error(`  ${violation}`)
  process.exit(1)
}
console.log('ios:check passed')
