#!/usr/bin/env node

/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import process from 'node:process'
import { Worker } from 'node:worker_threads'

import { ensureManagedPythonRuntime } from '../packages/runtime/src/services/python/managedPythonRuntime.ts'
import {
  NativeProcessBroker,
  resolveProcessHostBinary
} from '../packages/runtime/src/services/processBroker/nativeProcessBroker.ts'
import { createTool as createPyReplTool } from '../packages/runtime/src/tools/agentTools/pyReplTool.ts'
import { resolveBuildSpawnSpec } from './build-executables.mjs'

const repoRoot = resolve(import.meta.dirname, '..')
const desktopDir = join(repoRoot, 'apps', 'desktop')
const sourceRunnerPath = join(
  repoRoot,
  'packages',
  'runtime',
  'src',
  'tools',
  'agentTools',
  'pyReplRunner.py'
)
const temporaryRoot = await mkdtemp(join(tmpdir(), 'yachiyo-packaged-repls-'))
const buildDir = join(temporaryRoot, 'build')
const resourcesPath = join(temporaryRoot, 'resources')
const yachiyoHome = join(temporaryRoot, 'yachiyo-home')
const workspacePath = join(temporaryRoot, 'workspace')
const nonexistentProjectRoot = join(temporaryRoot, 'nonexistent-project-root')

function sha256(content) {
  return createHash('sha256').update(content).digest('hex')
}

async function findFiles(directory, predicate) {
  const matches = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      matches.push(...(await findFiles(path, predicate)))
    } else if (predicate(entry.name)) {
      matches.push(path)
    }
  }
  return matches
}

async function readReachableJavaScript(entryPath) {
  const mainRoot = dirname(entryPath)
  const pending = [entryPath]
  const reachable = new Map()
  const localModulePattern = /\b(?:require|import)\(\s*(['"])(\.{1,2}\/[^'"]+\.js)\1\s*\)/gu

  while (pending.length > 0) {
    const path = pending.pop()
    if (reachable.has(path)) continue

    const content = await readFile(path, 'utf8')
    reachable.set(path, content)
    for (const match of content.matchAll(localModulePattern)) {
      const dependencyPath = resolve(dirname(path), match[2])
      if (!dependencyPath.startsWith(`${mainRoot}${sep}`)) continue
      try {
        if ((await stat(dependencyPath)).isFile()) pending.push(dependencyPath)
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
    }
  }

  return reachable
}

function waitForWorkerMessage(worker, predicate, label) {
  return new Promise((resolveMessage, reject) => {
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error(`Timed out waiting for ${label}.`))
    }, 15_000)
    const cleanup = () => {
      clearTimeout(timeout)
      worker.off('message', onMessage)
      worker.off('error', onError)
      worker.off('exit', onExit)
    }
    const onMessage = (message) => {
      if (!predicate(message)) return
      cleanup()
      resolveMessage(message)
    }
    const onError = (error) => {
      cleanup()
      reject(error)
    }
    const onExit = (code) => {
      cleanup()
      reject(new Error(`Worker exited before ${label} with code ${code}.`))
    }
    worker.on('message', onMessage)
    worker.once('error', onError)
    worker.once('exit', onExit)
  })
}

async function executeJavaScriptCell(worker, runId, code) {
  const result = waitForWorkerMessage(
    worker,
    (message) => message?.type === 'result' && message.runId === runId,
    `result for ${runId}`
  )
  worker.postMessage({
    type: 'execute',
    runId,
    code,
    cwd: repoRoot,
    reset: false,
    timeoutMs: 5_000
  })
  return result
}

async function smokeJavaScriptWorker(workerPath) {
  const worker = new Worker(workerPath, { name: 'yachiyo-js-repl-packaged-smoke' })
  try {
    const ready = waitForWorkerMessage(worker, (message) => message?.type === 'ready', 'ready')
    worker.postMessage({ type: 'init', workspacePath: repoRoot, toolNames: [] })
    await ready

    const first = await executeJavaScriptCell(
      worker,
      'packaged-js-smoke-1',
      `import path from "node:path"; const answer = await Promise.resolve(6 * 7); display(path.basename("/tmp/demo")); answer`
    )
    assert.equal(first.error, undefined, JSON.stringify(first))
    assert.equal(first.result, '42')
    assert.deepEqual(first.displayOutputs, ['demo'])

    const second = await executeJavaScriptCell(worker, 'packaged-js-smoke-2', 'answer + 1')
    assert.equal(second.error, undefined, JSON.stringify(second))
    assert.equal(second.result, '43')
  } finally {
    await worker.terminate()
  }
}

function platformResourceDirectory() {
  const osByPlatform = { darwin: 'mac', linux: 'linux', win32: 'win' }
  return `${osByPlatform[process.platform] ?? process.platform}-${process.arch}`
}

async function stagePackagedUvResources() {
  const executableName = process.platform === 'win32' ? 'uv.exe' : 'uv'
  const sourceDirectory = join(desktopDir, 'resources', 'bin', platformResourceDirectory())
  const destinationDirectory = join(resourcesPath, 'bin')
  const resourceNames = [`${executableName}.runtime.gz`, `${executableName}.asset.json`]

  await mkdir(destinationDirectory, { recursive: true })
  await Promise.all(
    resourceNames.map((name) =>
      copyFile(join(sourceDirectory, name), join(destinationDirectory, name))
    )
  )
}

async function verifyPackagedAssets() {
  const pythonAssets = (await findFiles(buildDir, (name) => name.endsWith('.py'))).sort()
  assert.ok(pythonAssets.length > 0, `No emitted Python asset was found under ${buildDir}.`)

  const sourceRunnerHash = sha256(await readFile(sourceRunnerPath))
  const mainBundlePaths = [
    join(buildDir, 'main', 'index.js'),
    join(buildDir, 'main', 'runtime-host.js')
  ]
  const mainBundles = await Promise.all(
    mainBundlePaths.map(async (path) => ({
      path,
      reachable: await readReachableJavaScript(path)
    }))
  )

  for (const assetPath of pythonAssets) {
    assert.equal(
      sha256(await readFile(assetPath)),
      sourceRunnerHash,
      `Emitted Python runner differs from ${sourceRunnerPath}: ${assetPath}`
    )
    for (const bundle of mainBundles) {
      const referencingBundle = [...bundle.reachable.entries()].find(([, content]) =>
        content.includes(basename(assetPath))
      )
      assert.ok(
        referencingBundle,
        `${bundle.path} cannot reach emitted Python runner ${basename(assetPath)}.`
      )
    }
  }

  const workerPaths = (
    await findFiles(buildDir, (name) => /^jsReplWorker-[^.]+\.js$/u.test(name))
  ).sort()
  assert.ok(workerPaths.length > 0, `No bundled jsReplWorker entry was emitted under ${buildDir}.`)
  const workerNames = workerPaths.map((path) => basename(path))
  const referencedWorkers = new Set()
  for (const bundlePath of await findFiles(join(buildDir, 'main'), (name) =>
    name.endsWith('.js')
  )) {
    if (workerNames.includes(basename(bundlePath))) continue
    const bundle = await readFile(bundlePath, 'utf8')
    for (const workerName of workerNames) {
      if (bundle.includes(workerName)) referencedWorkers.add(workerName)
    }
  }
  for (const workerName of workerNames) {
    assert.ok(
      referencedWorkers.has(workerName),
      `No main-process bundle references emitted worker ${workerName}.`
    )
  }

  return { pythonRunnerPath: pythonAssets[0], workerPaths }
}

async function smokePythonRunner(runnerPath) {
  const broker = new NativeProcessBroker({ binaryPath: resolveProcessHostBinary() })
  let repl
  try {
    await broker.start()
    repl = createPyReplTool(
      {
        workspacePath,
        processBroker: broker,
        enabledTools: [],
        isModelImageCapable: true
      },
      {
        runnerPath,
        listToolNames: () => ['jsRepl', 'pyRepl'],
        resolveTool: () => undefined,
        ensureRuntime: async (options) =>
          await ensureManagedPythonRuntime({
            ...options,
            projectRoot: nonexistentProjectRoot,
            resourcesPath,
            yachiyoHome
          })
      }
    )

    const first = await repl.execute(
      {
        code: [
          'import sys',
          'assert sys.version_info[:3] == (3, 12, 14)',
          'packaged_answer = 6 * 7',
          'display({"answer": packaged_answer, "version": ".".join(map(str, sys.version_info[:3]))})',
          'packaged_answer'
        ].join('\n')
      },
      { toolCallId: 'packaged-py-smoke-1', messages: [] }
    )
    assert.equal(first.error, undefined, first.error)
    assert.equal(first.details.result, '42')
    assert.match(first.details.displayOutput ?? '', /"answer": 42/u)
    assert.match(first.details.displayOutput ?? '', /"version": "3\.12\.14"/u)

    const second = await repl.execute(
      { code: 'packaged_answer + 1' },
      { toolCallId: 'packaged-py-smoke-2', messages: [] }
    )
    assert.equal(second.error, undefined, second.error)
    assert.equal(second.details.result, '43')
  } finally {
    await repl?.dispose()
    await broker.close()
  }
}

async function buildIsolatedDesktop() {
  const electronViteBin = join(
    desktopDir,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'electron-vite.cmd' : 'electron-vite'
  )
  const invocation = resolveBuildSpawnSpec(
    process.platform,
    electronViteBin,
    ['build', '--outDir', buildDir],
    process.env
  )
  const build = spawnSync(invocation.command, invocation.args, {
    ...invocation.options,
    cwd: desktopDir,
    env: process.env,
    encoding: 'utf8',
    stdio: 'pipe'
  })
  if (build.error || build.status !== 0) {
    if (build.stdout) process.stdout.write(build.stdout)
    if (build.stderr) process.stderr.write(build.stderr)
    throw (
      build.error ?? new Error(`Isolated electron-vite build failed with status ${build.status}.`)
    )
  }
}

async function main() {
  let primaryError
  let cleanupError
  try {
    await Promise.all([
      mkdir(workspacePath, { recursive: true }),
      stagePackagedUvResources(),
      buildIsolatedDesktop()
    ])
    const { pythonRunnerPath, workerPaths } = await verifyPackagedAssets()
    for (const workerPath of workerPaths) await smokeJavaScriptWorker(workerPath)
    await smokePythonRunner(pythonRunnerPath)
    console.log(
      `✓ packaged REPL smoke passed (${workerPaths.map((path) => basename(path)).join(', ')}, ${basename(pythonRunnerPath)})`
    )
  } catch (error) {
    primaryError = error
  } finally {
    try {
      await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    } catch (error) {
      cleanupError = error
    }
  }
  if (primaryError && cleanupError) {
    throw new AggregateError(
      [primaryError, cleanupError],
      'Packaged REPL smoke and cleanup failed.'
    )
  }
  if (cleanupError) {
    throw cleanupError
  }
  if (primaryError) throw primaryError
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
