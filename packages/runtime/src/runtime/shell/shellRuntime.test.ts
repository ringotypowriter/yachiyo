import assert from 'node:assert/strict'
import { win32 } from 'node:path'
import test from 'node:test'

import { buildBashCommand, resolveHostShellRuntime, resolveShellRuntime } from './shellRuntime.ts'

const WINDOWS_HOME = 'C:\\Users\\Yuki 山田'
const WINDOWS_RESOURCES = 'C:\\Program Files (x86)\\Yachiyo\\resources'
const WINDOWS_CLI_BIN = 'C:\\Users\\Yuki 山田\\.yachiyo\\bin'

test('macOS ShellRuntime preserves the login-shell command contract', () => {
  const runtime = resolveShellRuntime({
    platform: 'darwin',
    arch: 'arm64',
    mode: 'development',
    projectRoot: '/workspace/yachiyo',
    resourcesPath: '/Applications/Yachiyo.app/Contents/Resources',
    homeDir: '/Users/yuki',
    cliBinDir: '/Users/yuki/.yachiyo/bin',
    env: { PATH: '/usr/local/bin:/usr/bin', PROFILE_VALUE: 'base' },
    loginShellExecutable: '/bin/zsh',
    readLoginShellEnvironment: () => ({
      PATH: '/opt/homebrew/bin:/usr/bin',
      PROFILE_VALUE: 'login'
    }),
    pathExists: () => true
  })

  assert.equal(runtime.kind, 'login-shell')
  assert.equal(runtime.executable, '/bin/zsh')
  assert.deepEqual(runtime.args('printf ok'), ['-lc', 'printf ok'])
  assert.deepEqual(runtime.environment, {
    PATH: '/opt/homebrew/bin:/usr/bin',
    PROFILE_VALUE: 'login'
  })
  assert.deepEqual(runtime.spawnOptions, { detached: true, windowsHide: false })
})

test('packaged Windows ShellRuntime resolves only the private PortableGit Bash', () => {
  const expectedBash = win32.join(WINDOWS_RESOURCES, 'bin', 'bash', 'usr', 'bin', 'bash.exe')
  const observedPaths: string[] = []
  const runtime = resolveShellRuntime({
    platform: 'win32',
    arch: 'x64',
    mode: 'packaged',
    projectRoot: 'D:\\source\\yachiyo',
    resourcesPath: WINDOWS_RESOURCES,
    homeDir: WINDOWS_HOME,
    cliBinDir: WINDOWS_CLI_BIN,
    env: { PATH: 'C:\\Windows\\System32;C:\\Tools\\bin' },
    pathExists: (path) => {
      observedPaths.push(path)
      return path === expectedBash
    }
  })

  assert.equal(runtime.kind, 'portable-git-bash')
  assert.equal(runtime.executable, expectedBash)
  assert.deepEqual(runtime.args('printf ok'), ['--noprofile', '--norc', '-c', 'printf ok'])
  assert.deepEqual(runtime.spawnOptions, { detached: true, windowsHide: true })
  assert.deepEqual(observedPaths, [expectedBash])
})

test('development Windows ShellRuntime uses the generated win-x64 resource tree', () => {
  const projectRoot = 'D:\\source tree\\yachiyo'
  const expectedBash = win32.join(
    projectRoot,
    'apps',
    'desktop',
    'resources',
    'bin',
    'win-x64',
    'bash',
    'usr',
    'bin',
    'bash.exe'
  )
  const runtime = resolveShellRuntime({
    platform: 'win32',
    arch: 'x64',
    mode: 'development',
    projectRoot,
    resourcesPath: WINDOWS_RESOURCES,
    homeDir: WINDOWS_HOME,
    cliBinDir: WINDOWS_CLI_BIN,
    env: {},
    pathExists: (path) => path === expectedBash
  })

  assert.equal(runtime.executable, expectedBash)
})

test('host ShellRuntime keeps platform assembly decisions inside the resolver', () => {
  const projectRoot = 'D:\\source tree\\yachiyo'
  const runtime = resolveHostShellRuntime({
    platform: 'win32',
    arch: 'x64',
    defaultApp: true,
    projectRoot,
    resourcesPath: WINDOWS_RESOURCES,
    homeDir: WINDOWS_HOME,
    cliBinDir: WINDOWS_CLI_BIN,
    env: { PATH: 'C:\\Windows\\System32' },
    pathExists: () => true
  })

  assert.equal(runtime.kind, 'portable-git-bash')
  assert.equal(
    runtime.executable,
    win32.join(
      projectRoot,
      'apps',
      'desktop',
      'resources',
      'bin',
      'win-x64',
      'bash',
      'usr',
      'bin',
      'bash.exe'
    )
  )
})

test('Windows ShellRuntime fails diagnostically instead of adopting Bash from user PATH', () => {
  assert.throws(
    () =>
      resolveShellRuntime({
        platform: 'win32',
        arch: 'x64',
        mode: 'packaged',
        projectRoot: 'D:\\source\\yachiyo',
        resourcesPath: WINDOWS_RESOURCES,
        homeDir: WINDOWS_HOME,
        cliBinDir: WINDOWS_CLI_BIN,
        env: { PATH: 'C:\\Program Files\\Git\\bin;C:\\Windows\\System32' },
        pathExists: () => false
      }),
    /Private PortableGit Bash is missing.*yachiyo doctor/iu
  )
})

test('Windows ShellRuntime prepends private bins without mutating its input environment', () => {
  const inputEnv = {
    PATH: 'C:\\Windows\\System32;C:\\Users\\Yuki\\bin',
    TEMP: 'C:\\Temp & Cache',
    TMP: 'C:\\Temp & Cache',
    HTTPS_PROXY: 'http://127.0.0.1:7890',
    PROFILE_OVERRIDE: 'preserved'
  }
  const originalEnv = { ...inputEnv }
  const originalProcessPath = process.env.PATH
  const runtime = resolveShellRuntime({
    platform: 'win32',
    arch: 'x64',
    mode: 'packaged',
    projectRoot: 'D:\\source\\yachiyo',
    resourcesPath: WINDOWS_RESOURCES,
    homeDir: WINDOWS_HOME,
    cliBinDir: WINDOWS_CLI_BIN,
    env: inputEnv,
    pathExists: () => true
  })
  const bashRoot = win32.join(WINDOWS_RESOURCES, 'bin', 'bash')
  const expectedPrefix = [
    WINDOWS_CLI_BIN,
    win32.join(WINDOWS_RESOURCES, 'bin'),
    win32.join(bashRoot, 'mingw64', 'bin'),
    win32.join(bashRoot, 'usr', 'bin')
  ].join(';')

  assert.deepEqual(inputEnv, originalEnv)
  assert.equal(process.env.PATH, originalProcessPath)
  assert.equal(runtime.environment.PATH, `${expectedPrefix};${inputEnv.PATH}`)
  assert.equal(runtime.environment.HOME, WINDOWS_HOME)
  assert.equal(runtime.environment.MSYSTEM, 'MINGW64')
  assert.equal(runtime.environment.CHERE_INVOKING, '1')
  assert.equal(runtime.environment.MSYS2_PATH_TYPE, 'inherit')
  assert.equal(runtime.environment.TEMP, inputEnv.TEMP)
  assert.equal(runtime.environment.HTTPS_PROXY, inputEnv.HTTPS_PROXY)
  assert.equal(runtime.environment.PROFILE_OVERRIDE, inputEnv.PROFILE_OVERRIDE)
  assert.equal(runtime.environment.MSYS_NO_PATHCONV, undefined)
  assert.equal(runtime.environment.MSYS2_ARG_CONV_EXCL, undefined)
})

test('Windows ShellRuntime preserves a case-insensitive Path key without duplicate variants', () => {
  const runtime = resolveShellRuntime({
    platform: 'win32',
    arch: 'x64',
    mode: 'packaged',
    projectRoot: 'D:\\source\\yachiyo',
    resourcesPath: WINDOWS_RESOURCES,
    homeDir: WINDOWS_HOME,
    cliBinDir: WINDOWS_CLI_BIN,
    env: { Path: 'C:\\Windows\\System32;D:\\Native Tools' },
    pathExists: () => true
  })

  assert.match(runtime.environment.PATH ?? '', /C:\\Windows\\System32;D:\\Native Tools$/u)
  assert.equal(runtime.environment.Path, undefined)
})

test('cwd remains a spawn option when a Windows path contains spaces, Unicode, ampersands, and parentheses', () => {
  const runtime = resolveShellRuntime({
    platform: 'win32',
    arch: 'x64',
    mode: 'packaged',
    projectRoot: 'D:\\source\\yachiyo',
    resourcesPath: WINDOWS_RESOURCES,
    homeDir: WINDOWS_HOME,
    cliBinDir: WINDOWS_CLI_BIN,
    env: {},
    pathExists: () => true
  })
  const cwd = 'C:\\Users\\Yuki 山田\\Work & Notes (2026)'

  assert.deepEqual(runtime.command('pwd', { cwd }), {
    executable: runtime.executable,
    args: ['--noprofile', '--norc', '-c', 'pwd'],
    options: {
      cwd,
      detached: true,
      env: runtime.environment,
      windowsHide: true
    }
  })
})

test('ACP command and every argument are quoted as separate Bash tokens', () => {
  assert.equal(
    buildBashCommand('C:\\Program Files\\Agent & Tools\\agent.exe', [
      '--workspace',
      'C:\\Users\\Yuki 山田\\Work (2026)',
      "Ringo's notes",
      '$HOME'
    ]),
    "'C:\\Program Files\\Agent & Tools\\agent.exe' '--workspace' 'C:\\Users\\Yuki 山田\\Work (2026)' 'Ringo'\\''s notes' '$HOME'"
  )
})
