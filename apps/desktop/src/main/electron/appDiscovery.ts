import { execFile } from 'node:child_process'
import { readFile, readdir, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const KNOWN_EDITORS = [
  'Zed',
  'Zed Preview',
  'Cursor',
  'Visual Studio Code',
  'Visual Studio Code - Insiders',
  'Trae',
  'Trae CN',
  'Windsurf',
  'Xcode',
  'Nova',
  'Sublime Text',
  'Obsidian'
]

const KNOWN_TERMINALS = ['Ghostty', 'Warp', 'iTerm', 'Terminal', 'Alacritty', 'Hyper', 'kitty']

const KNOWN_MARKDOWN_EDITORS = ['Obsidian', 'Typora', 'MarkEdit', 'Zettlr']

export interface DiscoveredApp {
  name: string
  iconDataUrl?: string
}

export interface DiscoveredApps {
  editors: DiscoveredApp[]
  terminals: DiscoveredApp[]
  markdownEditors: DiscoveredApp[]
}

async function listAppsInDir(dir: string): Promise<Map<string, string>> {
  try {
    const entries = await readdir(dir)
    const result = new Map<string, string>()
    for (const e of entries) {
      if (e.endsWith('.app')) {
        result.set(e.slice(0, -4), join(dir, e))
      }
    }
    return result
  } catch {
    return new Map()
  }
}

// Uses macOS builtins only — no npm deps, no native rebuild needed.
// `defaults read` handles both binary and XML Info.plist natively.
// `sips` converts .icns → PNG in-process without a temp app launch.
async function getIconFromBundle(appPath: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('defaults', [
      'read',
      join(appPath, 'Contents/Info'),
      'CFBundleIconFile'
    ])

    let iconFile = stdout.trim()
    if (!iconFile) return undefined
    if (!iconFile.endsWith('.icns')) iconFile += '.icns'

    const icnsPath = join(appPath, 'Contents', 'Resources', iconFile)
    const outPath = join(tmpdir(), `yachiyo-icon-${randomUUID()}.png`)

    try {
      await execFileAsync('/usr/bin/sips', [
        '-s',
        'format',
        'png',
        '--resampleHeightWidthMax',
        '64',
        icnsPath,
        '--out',
        outPath
      ])
      const buffer = await readFile(outPath)
      return `data:image/png;base64,${buffer.toString('base64')}`
    } finally {
      await unlink(outPath).catch(() => {})
    }
  } catch {
    return undefined
  }
}

export async function discoverApps(): Promise<DiscoveredApps> {
  try {
    const dirs = [
      '/Applications',
      join(homedir(), 'Applications'),
      '/System/Applications',
      '/System/Applications/Utilities'
    ]
    const dirMaps = await Promise.all(dirs.map(listAppsInDir))

    // Earlier dirs take priority (/Applications wins over /System/Applications)
    const all = new Map<string, string>()
    for (const map of [...dirMaps].reverse()) {
      for (const [name, path] of map) {
        all.set(name, path)
      }
    }

    async function toDiscoveredApp(name: string): Promise<DiscoveredApp | null> {
      const appPath = all.get(name)
      if (!appPath) return null
      const iconDataUrl = await getIconFromBundle(appPath)
      return { name, iconDataUrl }
    }

    const [editors, terminals, markdownEditors] = await Promise.all([
      Promise.all(KNOWN_EDITORS.map(toDiscoveredApp)).then((r) =>
        r.filter((x): x is DiscoveredApp => x !== null)
      ),
      Promise.all(KNOWN_TERMINALS.map(toDiscoveredApp)).then((r) =>
        r.filter((x): x is DiscoveredApp => x !== null)
      ),
      Promise.all(KNOWN_MARKDOWN_EDITORS.map(toDiscoveredApp)).then((r) =>
        r.filter((x): x is DiscoveredApp => x !== null)
      )
    ])

    return { editors, terminals, markdownEditors }
  } catch {
    return { editors: [], terminals: [], markdownEditors: [] }
  }
}
