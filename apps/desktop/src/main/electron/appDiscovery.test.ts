import assert from 'node:assert/strict'
import { win32 } from 'node:path'
import test from 'node:test'

import { buildAppLaunchSpec, discoverApps } from './appDiscovery.ts'

const ENV = {
  LOCALAPPDATA: 'C:\\Users\\Yuki\\AppData\\Local',
  ProgramFiles: 'C:\\Program Files',
  'ProgramFiles(x86)': 'C:\\Program Files (x86)',
  PATH: 'C:\\Windows\\System32;D:\\Portable Apps'
}

test('Windows known-app catalog covers every required editor, terminal, and Markdown app', async () => {
  const result = await discoverApps({
    platform: 'win32',
    env: ENV,
    pathExists: () => true,
    findExecutableOnPath: () => undefined,
    getFileIcon: async (path) => `icon:${path}`
  })

  for (const name of [
    'Zed',
    'Cursor',
    'Visual Studio Code',
    'Visual Studio Code Insiders',
    'Windsurf',
    'Sublime Text',
    'Obsidian'
  ]) {
    assert.ok(
      result.editors.some((app) => app.name === name),
      `missing editor: ${name}`
    )
  }
  for (const name of [
    'Windows Terminal',
    'Windows PowerShell',
    'PowerShell 7',
    'Alacritty',
    'WezTerm',
    'Hyper',
    'kitty'
  ]) {
    assert.ok(
      result.terminals.some((app) => app.name === name),
      `missing terminal: ${name}`
    )
  }
  for (const name of ['Obsidian', 'Typora', 'Zettlr']) {
    assert.ok(
      result.markdownEditors.some((app) => app.name === name),
      `missing Markdown editor: ${name}`
    )
  }

  const ids = [result.editors, result.terminals, result.markdownEditors].flat().map((app) => app.id)
  assert.equal(new Set(ids).size, ids.length)
})

test('Windows discovery combines known install paths and PATH with stable identities', async () => {
  const codePath = win32.join(ENV.LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'Code.exe')
  const cursorPath = win32.join(ENV.LOCALAPPDATA, 'Programs', 'cursor', 'Cursor.exe')
  const obsidianPath = win32.join(ENV.LOCALAPPDATA, 'Programs', 'Obsidian', 'Obsidian.exe')
  const typoraPath = win32.join(ENV.ProgramFiles, 'Typora', 'Typora.exe')
  const existing = new Set([codePath, cursorPath, obsidianPath, typoraPath])
  const pathExecutables = new Map([
    ['cursor.exe', 'D:\\Portable Apps\\cursor.exe'],
    ['wt.exe', 'C:\\Windows\\System32\\wt.exe'],
    ['powershell.exe', 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe']
  ])

  const result = await discoverApps({
    platform: 'win32',
    env: ENV,
    pathExists: (path) => existing.has(path),
    findExecutableOnPath: (name) => pathExecutables.get(name),
    getFileIcon: async (path) => `icon:${path}`
  })

  assert.deepEqual(
    result.editors.map(({ id, name, executablePath, kind }) => ({
      id,
      name,
      executablePath,
      kind
    })),
    [
      {
        id: 'editor:vscode',
        name: 'Visual Studio Code',
        executablePath: codePath,
        kind: 'editor'
      },
      {
        id: 'editor:cursor',
        name: 'Cursor',
        executablePath: cursorPath,
        kind: 'editor'
      },
      {
        id: 'editor:obsidian',
        name: 'Obsidian',
        executablePath: obsidianPath,
        kind: 'editor'
      }
    ]
  )
  assert.ok(result.editors.every((app) => app.iconDataUrl === `icon:${app.executablePath}`))
  assert.equal(
    result.editors.some((app) => app.name === 'Zed'),
    false
  )
  assert.equal(result.editors.filter((app) => app.name === 'Cursor').length, 1)
  assert.ok(result.terminals.some((app) => app.id === 'terminal:windows-terminal'))
  assert.ok(result.terminals.some((app) => app.id === 'terminal:windows-powershell'))
  assert.ok(result.markdownEditors.some((app) => app.id === 'markdown:obsidian'))
  assert.ok(result.markdownEditors.some((app) => app.id === 'markdown:typora'))
})

test('app launch keeps executable, launch arguments, and target path as separate process tokens', () => {
  const targetPath = 'C:\\Users\\Yuki\\Work & Notes (2026)'
  const launch = buildAppLaunchSpec(
    {
      id: 'editor:vscode',
      name: 'Visual Studio Code',
      executablePath: 'C:\\Program Files\\Microsoft VS Code\\Code.exe',
      kind: 'editor',
      launchArguments: ['--new-window']
    },
    { targetPath }
  )

  assert.deepEqual(launch, {
    executable: 'C:\\Program Files\\Microsoft VS Code\\Code.exe',
    args: ['--new-window', targetPath],
    options: { shell: false, windowsHide: true }
  })
})

test('terminal launch passes the workspace as a native cwd argument', () => {
  const workspacePath = 'D:\\Projects\\Yachiyo & Friends'
  const launch = buildAppLaunchSpec(
    {
      id: 'terminal:windows-terminal',
      name: 'Windows Terminal',
      executablePath: 'C:\\Windows\\System32\\wt.exe',
      kind: 'terminal',
      launchArguments: ['-d']
    },
    { targetPath: workspacePath }
  )

  assert.deepEqual(launch.args, ['-d', workspacePath])
  assert.equal(launch.options.shell, false)
})
