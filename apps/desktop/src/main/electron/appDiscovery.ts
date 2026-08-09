import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, readdir, unlink } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import { promisify } from 'node:util'
import type {
  DiscoveredApp,
  DiscoveredAppKind,
  DiscoveredApps
} from '@yachiyo/shared/discoveredApp'

const execFileAsync = promisify(execFile)

export interface DiscoverAppsOptions {
  platform?: NodeJS.Platform
  env?: Readonly<Record<string, string | undefined>>
  pathExists?: (path: string) => boolean | Promise<boolean>
  findExecutableOnPath?: (name: string) => string | undefined | Promise<string | undefined>
  getFileIcon?: (path: string) => Promise<string | undefined>
}

export interface AppLaunchSpec {
  executable: string
  args: string[]
  options: {
    shell: false
    windowsHide: true
  }
}

interface WindowsAppDefinition {
  id: string
  name: string
  kind: DiscoveredAppKind
  candidatePaths: (env: Readonly<Record<string, string | undefined>>) => string[]
  pathExecutables: string[]
  launchArguments?: string[]
}

const MAC_EDITORS = [
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

const MAC_TERMINALS = ['Ghostty', 'Warp', 'iTerm', 'Terminal', 'Alacritty', 'Hyper', 'kitty']
const MAC_MARKDOWN_EDITORS = ['Obsidian', 'Typora', 'MarkEdit', 'Zettlr']

function under(root: string | undefined, ...parts: string[]): string[] {
  return root ? [win32.join(root, ...parts)] : []
}

const WINDOWS_APPS: readonly WindowsAppDefinition[] = [
  {
    id: 'editor:vscode',
    name: 'Visual Studio Code',
    kind: 'editor',
    candidatePaths: (env) => [
      ...under(env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'Code.exe'),
      ...under(env.ProgramFiles, 'Microsoft VS Code', 'Code.exe')
    ],
    pathExecutables: ['code.exe'],
    launchArguments: ['--new-window']
  },
  {
    id: 'editor:vscode-insiders',
    name: 'Visual Studio Code Insiders',
    kind: 'editor',
    candidatePaths: (env) => [
      ...under(env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code Insiders', 'Code - Insiders.exe'),
      ...under(env.ProgramFiles, 'Microsoft VS Code Insiders', 'Code - Insiders.exe')
    ],
    pathExecutables: ['code-insiders.exe'],
    launchArguments: ['--new-window']
  },
  {
    id: 'editor:zed',
    name: 'Zed',
    kind: 'editor',
    candidatePaths: (env) => [
      ...under(env.LOCALAPPDATA, 'Programs', 'Zed', 'Zed.exe'),
      ...under(env.LOCALAPPDATA, 'Zed', 'Zed.exe')
    ],
    pathExecutables: ['zed.exe']
  },
  {
    id: 'editor:cursor',
    name: 'Cursor',
    kind: 'editor',
    candidatePaths: (env) => [
      ...under(env.LOCALAPPDATA, 'Programs', 'cursor', 'Cursor.exe'),
      ...under(env.ProgramFiles, 'Cursor', 'Cursor.exe')
    ],
    pathExecutables: ['cursor.exe'],
    launchArguments: ['--new-window']
  },
  {
    id: 'editor:windsurf',
    name: 'Windsurf',
    kind: 'editor',
    candidatePaths: (env) => [
      ...under(env.LOCALAPPDATA, 'Programs', 'Windsurf', 'Windsurf.exe'),
      ...under(env.ProgramFiles, 'Windsurf', 'Windsurf.exe')
    ],
    pathExecutables: ['windsurf.exe'],
    launchArguments: ['--new-window']
  },
  {
    id: 'editor:sublime-text',
    name: 'Sublime Text',
    kind: 'editor',
    candidatePaths: (env) => [
      ...under(env.ProgramFiles, 'Sublime Text', 'sublime_text.exe'),
      ...under(env['ProgramFiles(x86)'], 'Sublime Text', 'sublime_text.exe')
    ],
    pathExecutables: ['sublime_text.exe']
  },
  {
    id: 'editor:obsidian',
    name: 'Obsidian',
    kind: 'editor',
    candidatePaths: (env) => [
      ...under(env.LOCALAPPDATA, 'Programs', 'Obsidian', 'Obsidian.exe'),
      ...under(env.ProgramFiles, 'Obsidian', 'Obsidian.exe')
    ],
    pathExecutables: ['obsidian.exe']
  },
  {
    id: 'terminal:windows-terminal',
    name: 'Windows Terminal',
    kind: 'terminal',
    candidatePaths: (env) => [...under(env.LOCALAPPDATA, 'Microsoft', 'WindowsApps', 'wt.exe')],
    pathExecutables: ['wt.exe'],
    launchArguments: ['-d']
  },
  {
    id: 'terminal:windows-powershell',
    name: 'Windows PowerShell',
    kind: 'terminal',
    candidatePaths: (env) => [
      win32.join(
        env.SystemRoot ?? 'C:\\Windows',
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe'
      )
    ],
    pathExecutables: ['powershell.exe'],
    launchArguments: ['-NoExit', '-Command', 'Set-Location', '-LiteralPath']
  },
  {
    id: 'terminal:powershell-7',
    name: 'PowerShell 7',
    kind: 'terminal',
    candidatePaths: (env) => [
      ...under(env.ProgramFiles, 'PowerShell', '7', 'pwsh.exe'),
      ...under(env.LOCALAPPDATA, 'Microsoft', 'WindowsApps', 'pwsh.exe')
    ],
    pathExecutables: ['pwsh.exe'],
    launchArguments: ['-NoExit', '-WorkingDirectory']
  },
  {
    id: 'terminal:alacritty',
    name: 'Alacritty',
    kind: 'terminal',
    candidatePaths: (env) => [
      ...under(env.ProgramFiles, 'Alacritty', 'alacritty.exe'),
      ...under(env.LOCALAPPDATA, 'Programs', 'Alacritty', 'alacritty.exe')
    ],
    pathExecutables: ['alacritty.exe'],
    launchArguments: ['--working-directory']
  },
  {
    id: 'terminal:wezterm',
    name: 'WezTerm',
    kind: 'terminal',
    candidatePaths: (env) => [
      ...under(env.ProgramFiles, 'WezTerm', 'wezterm-gui.exe'),
      ...under(env.LOCALAPPDATA, 'Programs', 'WezTerm', 'wezterm-gui.exe')
    ],
    pathExecutables: ['wezterm-gui.exe', 'wezterm.exe'],
    launchArguments: ['start', '--cwd']
  },
  {
    id: 'terminal:hyper',
    name: 'Hyper',
    kind: 'terminal',
    candidatePaths: (env) => [
      ...under(env.LOCALAPPDATA, 'Programs', 'Hyper', 'Hyper.exe'),
      ...under(env.ProgramFiles, 'Hyper', 'Hyper.exe')
    ],
    pathExecutables: ['hyper.exe'],
    launchArguments: ['--cwd']
  },
  {
    id: 'terminal:kitty',
    name: 'kitty',
    kind: 'terminal',
    candidatePaths: (env) => [
      ...under(env.ProgramFiles, 'kitty', 'kitty.exe'),
      ...under(env.LOCALAPPDATA, 'Programs', 'kitty', 'kitty.exe')
    ],
    pathExecutables: ['kitty.exe'],
    launchArguments: ['--directory']
  },
  {
    id: 'markdown:obsidian',
    name: 'Obsidian',
    kind: 'markdown',
    candidatePaths: (env) => [
      ...under(env.LOCALAPPDATA, 'Programs', 'Obsidian', 'Obsidian.exe'),
      ...under(env.ProgramFiles, 'Obsidian', 'Obsidian.exe')
    ],
    pathExecutables: ['obsidian.exe']
  },
  {
    id: 'markdown:typora',
    name: 'Typora',
    kind: 'markdown',
    candidatePaths: (env) => [
      ...under(env.ProgramFiles, 'Typora', 'Typora.exe'),
      ...under(env.LOCALAPPDATA, 'Programs', 'Typora', 'Typora.exe')
    ],
    pathExecutables: ['typora.exe']
  },
  {
    id: 'markdown:zettlr',
    name: 'Zettlr',
    kind: 'markdown',
    candidatePaths: (env) => [
      ...under(env.LOCALAPPDATA, 'Programs', 'Zettlr', 'Zettlr.exe'),
      ...under(env.ProgramFiles, 'Zettlr', 'Zettlr.exe')
    ],
    pathExecutables: ['zettlr.exe']
  }
]

async function listAppsInDir(dir: string): Promise<Map<string, string>> {
  try {
    const entries = await readdir(dir)
    const result = new Map<string, string>()
    for (const entry of entries) {
      if (entry.endsWith('.app')) {
        result.set(entry.slice(0, -4), join(dir, entry))
      }
    }
    return result
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'EACCES') return new Map()
    throw error
  }
}

// Uses macOS builtins only — no npm deps, no native rebuild needed.
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

    const outPath = join(tmpdir(), `yachiyo-icon-${randomUUID()}.png`)
    try {
      await execFileAsync('/usr/bin/sips', [
        '-s',
        'format',
        'png',
        '--resampleHeightWidthMax',
        '64',
        join(appPath, 'Contents', 'Resources', iconFile),
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

async function getWindowsFileIcon(path: string): Promise<string | undefined> {
  const { app } = await import('electron')
  const image = await app.getFileIcon(path, { size: 'small' })
  return image.isEmpty() ? undefined : image.toDataURL()
}

function findExecutableOnWindowsPath(
  executable: string,
  env: Readonly<Record<string, string | undefined>>
): string | undefined {
  for (const directory of (env.PATH ?? '').split(';')) {
    if (!directory) continue
    const candidate = win32.join(directory, executable)
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

async function discoverWindowsApps(options: DiscoverAppsOptions): Promise<DiscoveredApps> {
  const env = options.env ?? process.env
  const pathExists = options.pathExists ?? existsSync
  const findExecutable =
    options.findExecutableOnPath ?? ((name: string) => findExecutableOnWindowsPath(name, env))
  const getFileIcon = options.getFileIcon ?? getWindowsFileIcon

  const found = await Promise.all(
    WINDOWS_APPS.map(async (definition): Promise<DiscoveredApp | null> => {
      let executablePath: string | undefined
      for (const candidate of definition.candidatePaths(env)) {
        if (await pathExists(candidate)) {
          executablePath = candidate
          break
        }
      }
      if (!executablePath) {
        for (const executable of definition.pathExecutables) {
          executablePath = await findExecutable(executable)
          if (executablePath) break
        }
      }
      if (!executablePath) return null

      const iconDataUrl = await getFileIcon(executablePath).catch(() => undefined)
      return {
        id: definition.id,
        name: definition.name,
        executablePath,
        kind: definition.kind,
        launchArguments: definition.launchArguments,
        iconDataUrl
      }
    })
  )

  const apps = found.filter((entry): entry is DiscoveredApp => entry !== null)
  return {
    editors: apps.filter((entry) => entry.kind === 'editor'),
    terminals: apps.filter((entry) => entry.kind === 'terminal'),
    markdownEditors: apps.filter((entry) => entry.kind === 'markdown')
  }
}

function macAppId(kind: DiscoveredAppKind, name: string): string {
  return `${kind}:${name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')}`
}

async function discoverMacApps(): Promise<DiscoveredApps> {
  const dirs = [
    '/Applications',
    join(homedir(), 'Applications'),
    '/System/Applications',
    '/System/Applications/Utilities'
  ]
  const dirMaps = await Promise.all(dirs.map(listAppsInDir))
  const all = new Map<string, string>()
  for (const map of [...dirMaps].reverse()) {
    for (const [name, path] of map) all.set(name, path)
  }

  async function discoverCategory(
    names: readonly string[],
    kind: DiscoveredAppKind
  ): Promise<DiscoveredApp[]> {
    const results = await Promise.all(
      names.map(async (name): Promise<DiscoveredApp | null> => {
        const bundlePath = all.get(name)
        if (!bundlePath) return null
        return {
          id: macAppId(kind, name),
          name,
          executablePath: '/usr/bin/open',
          kind,
          launchArguments: ['-a', name],
          iconDataUrl: await getIconFromBundle(bundlePath)
        }
      })
    )
    return results.filter((entry): entry is DiscoveredApp => entry !== null)
  }

  const [editors, terminals, markdownEditors] = await Promise.all([
    discoverCategory(MAC_EDITORS, 'editor'),
    discoverCategory(MAC_TERMINALS, 'terminal'),
    discoverCategory(MAC_MARKDOWN_EDITORS, 'markdown')
  ])
  return { editors, terminals, markdownEditors }
}

export async function discoverApps(options: DiscoverAppsOptions = {}): Promise<DiscoveredApps> {
  const platform = options.platform ?? process.platform
  if (platform === 'win32') return discoverWindowsApps(options)
  if (platform === 'darwin') return discoverMacApps()
  return { editors: [], terminals: [], markdownEditors: [] }
}

export function findDiscoveredApp(
  apps: DiscoveredApps,
  selection: string,
  kinds?: readonly DiscoveredAppKind[]
): DiscoveredApp | undefined {
  return [apps.editors, apps.terminals, apps.markdownEditors]
    .flat()
    .find(
      (entry) =>
        (!kinds || kinds.includes(entry.kind)) &&
        (entry.id === selection || entry.name === selection)
    )
}

export function buildAppLaunchSpec(
  app: DiscoveredApp,
  input: { targetPath: string }
): AppLaunchSpec {
  return {
    executable: app.executablePath,
    args: [...(app.launchArguments ?? []), input.targetPath],
    options: { shell: false, windowsHide: true }
  }
}

export async function launchDiscoveredApp(
  app: DiscoveredApp,
  input: { targetPath: string }
): Promise<void> {
  const launch = buildAppLaunchSpec(app, input)
  await new Promise<void>((resolve, reject) => {
    const child = spawn(launch.executable, launch.args, {
      ...launch.options,
      detached: true,
      stdio: 'ignore'
    })
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
    child.once('error', reject)
  })
}
