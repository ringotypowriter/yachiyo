/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { Worker } from 'node:worker_threads'

import { resolveBuildSpawnSpec } from './build-executables.mjs'

const repoRoot = resolve(import.meta.dirname, '..')
const desktopDir = join(repoRoot, 'apps', 'desktop')
const buildDir = await mkdtemp(join(tmpdir(), 'yachiyo-js-repl-smoke-'))

async function findWorkerBundles(directory) {
  const matches = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      matches.push(...(await findWorkerBundles(path)))
    } else if (/^jsReplWorker-[^.]+\.js$/u.test(entry.name)) {
      matches.push(path)
    }
  }
  return matches
}

async function findJavaScriptBundles(directory) {
  const matches = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      matches.push(...(await findJavaScriptBundles(path)))
    } else if (entry.name.endsWith('.js')) {
      matches.push(path)
    }
  }
  return matches
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

async function executeCell(worker, runId, code) {
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

async function smokeWorker(workerPath) {
  const worker = new Worker(workerPath, { name: 'yachiyo-js-repl-packaged-smoke' })
  try {
    const ready = waitForWorkerMessage(worker, (message) => message?.type === 'ready', 'ready')
    worker.postMessage({ type: 'init', workspacePath: repoRoot, toolNames: [] })
    await ready

    const first = await executeCell(
      worker,
      'packaged-smoke-1',
      `import path from "node:path"; const answer = await Promise.resolve(6 * 7); display(path.basename("/tmp/demo")); answer`
    )
    if (
      first.error ||
      first.result !== '42' ||
      first.displayOutputs.length !== 1 ||
      first.displayOutputs[0] !== 'demo'
    ) {
      throw new Error(`Unexpected first worker result: ${JSON.stringify(first)}`)
    }

    const second = await executeCell(worker, 'packaged-smoke-2', 'answer + 1')
    if (second.error || second.result !== '43') {
      throw new Error(`Unexpected persistent worker result: ${JSON.stringify(second)}`)
    }
  } finally {
    await worker.terminate()
  }
}

try {
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

  const workers = await findWorkerBundles(buildDir)
  if (workers.length === 0) {
    throw new Error(`No bundled jsReplWorker entry was emitted under ${buildDir}.`)
  }
  const workerNames = workers.map((path) => basename(path))
  const referencedWorkers = new Set()
  for (const bundlePath of await findJavaScriptBundles(join(buildDir, 'main'))) {
    if (workerNames.includes(basename(bundlePath))) continue
    const bundle = await readFile(bundlePath, 'utf8')
    for (const workerName of workerNames) {
      if (bundle.includes(workerName)) referencedWorkers.add(workerName)
    }
  }
  for (const workerName of workerNames) {
    if (!referencedWorkers.has(workerName)) {
      throw new Error(`No main-process bundle references emitted worker ${workerName}.`)
    }
  }
  for (const workerPath of workers) await smokeWorker(workerPath)
  console.log(
    `✓ packaged jsRepl worker smoke passed (${workers.map((path) => basename(path)).join(', ')})`
  )
} finally {
  await rm(buildDir, { recursive: true, force: true })
}
