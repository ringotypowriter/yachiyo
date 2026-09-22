/* eslint-disable @typescript-eslint/explicit-function-return-type */
// Exports the Lucide icons the iOS app uses into its asset catalog as template vectors with the
// desktop's 1.5 stroke, so both apps draw the same glyphs.
//   pnpm run ios:icons            write apps/ios/YachiyoRemote/Resources/Assets.xcassets/Lucide
//   pnpm run ios:icons -- --check  fail when the catalog does not match this list
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sourceDir = resolve(root, 'node_modules/lucide-static/icons')
const catalogDir = resolve(root, 'apps/ios/YachiyoRemote/Resources/Assets.xcassets/Lucide')
const check = process.argv.includes('--check')

// Mirrors the desktop mappings (see toolCallIcons.ts and the iOS design doc); `mic` is iOS-only.
export const IOS_ICONS = [
  // Navigation and actions
  'square-pen',
  'send-horizontal',
  'square',
  'paperclip',
  'cpu',
  'brain',
  'sparkles',
  'message-circle-question',
  'git-branch',
  'git-branch-plus',
  'archive',
  'star',
  'folder',
  'list-filter',
  'lock',
  'zap',
  'telescope',
  'map',
  'message-square',
  'mic',
  'search',
  'rotate-ccw',
  'pencil',
  'copy',
  'check',
  'x',
  'chevron-down',
  'chevron-right',
  'chevron-left',
  'circle-alert',
  'wifi-off',
  'qr-code',
  'smartphone',
  'laptop',
  'settings',
  'plus',
  'image',
  'camera',
  'file',
  'arrow-up',
  'loader',
  'ellipsis',
  'inbox',
  'clock',
  'circle-check',
  'circle-x',
  // Tool calls
  'app-window',
  'book-open-check',
  'boxes',
  'clipboard-list',
  'clipboard-pen-line',
  'contact-round',
  'database-zap',
  'diff',
  'door-open',
  'eye',
  'file-plus-2',
  'folder-search-2',
  'list-checks',
  'messages-square',
  'network',
  'newspaper',
  'pen-line',
  'radar',
  'square-terminal',
  'text-search',
  'wrench',
  'file-code'
]

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`
}

async function render() {
  const files = new Map()
  files.set(
    'Contents.json',
    json({ info: { author: 'xcode', version: 1 }, properties: { 'provides-namespace': true } })
  )
  for (const name of [...IOS_ICONS].sort()) {
    const svg = (await readFile(join(sourceDir, `${name}.svg`), 'utf8'))
      .replace(/stroke-width="2"/g, 'stroke-width="1.5"')
      // CoreSVG does not resolve currentColor; template rendering only uses the alpha channel.
      .replace(/currentColor/g, '#000000')
    files.set(`${name}.imageset/${name}.svg`, svg)
    files.set(
      `${name}.imageset/Contents.json`,
      json({
        images: [{ filename: `${name}.svg`, idiom: 'universal' }],
        info: { author: 'xcode', version: 1 },
        properties: {
          'preserves-vector-representation': true,
          'template-rendering-intent': 'template'
        }
      })
    )
  }
  return files
}

async function listExisting(dir, prefix = '') {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const out = []
  for (const entry of entries) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) out.push(...(await listExisting(join(dir, entry.name), path)))
    else out.push(path)
  }
  return out
}

const files = await render()
const existing = await listExisting(catalogDir)
let stale = existing.some((path) => !files.has(path))
for (const [path, content] of files) {
  const current = await readFile(join(catalogDir, path), 'utf8').catch(() => null)
  if (current !== content) stale = true
}

if (check) {
  if (stale) {
    console.error('Lucide asset catalog is stale. Run: pnpm run ios:icons')
    process.exit(1)
  }
  console.log(`Lucide asset catalog is up to date (${IOS_ICONS.length} icons)`)
} else if (stale) {
  await rm(catalogDir, { recursive: true, force: true })
  for (const [path, content] of files) {
    await mkdir(dirname(join(catalogDir, path)), { recursive: true })
    await writeFile(join(catalogDir, path), content)
  }
  console.log(`wrote ${IOS_ICONS.length} icons`)
}
