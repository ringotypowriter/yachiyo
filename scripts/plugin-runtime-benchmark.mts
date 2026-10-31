// Synthetic data through the real PluginSession API, including IPC and result validation.
// node --experimental-strip-types scripts/plugin-runtime-benchmark.mts --baseline 5c7156bc
// Bundles both revisions like headless builds. No providers, native modules or user state.
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { cpus, loadavg, release, tmpdir, totalmem } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { PluginSession as Session } from '../packages/runtime/src/services/plugins/pluginSession.ts'
import type { PluginState as State } from '../packages/runtime/src/services/plugins/pluginState.ts'
import type {
  PluginContext,
  PluginEventMap,
  PluginHooks
} from '../packages/runtime/src/services/plugins/pluginTypes.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const context: PluginContext = {
  runId: 'bench-run',
  threadId: 'bench-thread',
  workspacePath: '/synthetic',
  runMode: 'auto'
}
const passthrough = `export default {apiVersion: 1, hooks: {
  beforeModel({messages}) {return {messages}},
  textDelta({text}) {return {text}}
}}`
const stateSource = `export default {apiVersion: 1, hooks: {
  async beforeInput({text}, {state}) {
    const current = await state.read(text, 'counter')
    const next = await state.write(text, 'counter', current.version, (current.value ?? 0) + 1)
    return {text: String(next.value)}
  }
}}`

function checksum(text: string): string {
  let hash = 2166136261
  for (let index = 0; index < text.length; index++)
    hash = Math.imul(hash ^ text.charCodeAt(index), 16777619)
  return String(hash >>> 0)
}

function sources(
  count: number,
  source = passthrough
): { name: string; revision: string; source: string }[] {
  return Array.from({ length: count }, (_, index) => ({
    name: `bench-${index}.js`,
    revision: 'benchmark',
    source
  }))
}

interface Sample {
  name: string
  unit: 'ms' | 'MiB'
  values: number[]
}

interface Case {
  name: string
  count: number
  source?: string
  hook: keyof PluginHooks
  event: PluginEventMap[keyof PluginHooks]
  iterations: number
  verify(value: unknown, iteration: number): void
}

function contextMessages(bytes: number): { role: 'user' | 'assistant'; content: string }[] {
  return Array.from({ length: 64 }, (_, index) => ({
    role: index % 2 ? 'assistant' : 'user',
    content: String(index).padStart(4, '0') + 'x'.repeat(bytes / 64 - 4)
  }))
}

async function child(bundle: string, mode: string, count: number): Promise<void> {
  const { PluginSession, PluginState } = (await import(pathToFileURL(bundle).href)) as {
    PluginSession: typeof Session
    PluginState: typeof State
  }
  const directory = await mkdtemp(join(tmpdir(), 'yachiyo-plugin-bench-state-'))
  try {
    if (mode === 'memory' || mode === 'memory-context') {
      assert(global.gc, 'Memory measurements require --expose-gc')
      global.gc()
      const before = process.memoryUsage().rss
      const session = await PluginSession.create(sources(count), {
        state: new PluginState({ directory })
      })
      try {
        for (let index = 0; index < 100; index++)
          await session.dispatch('textDelta', context, { text: 'warmup', stepNumber: 0 })
        if (mode === 'memory-context') {
          const messages = contextMessages(1024 * 1024)
          for (let index = 0; index < 20; index++) {
            await session.dispatch('beforeModel', context, { messages, stepNumber: index })
          }
        }
        global.gc()
        console.log(
          JSON.stringify([
            {
              name: `rss-added-${count}-plugins${mode === 'memory-context' ? '-1024KiB-context' : ''}`,
              unit: 'MiB',
              values: [(process.memoryUsage().rss - before) / 1024 ** 2]
            }
          ])
        )
      } finally {
        await session.dispose()
      }
      return
    }
    const samples: Sample[] = []
    const firstContext: number[] = []
    const initialMessages = contextMessages(1024 * 1024)
    for (const pluginCount of [1, 5, 10]) {
      const values: number[] = []
      for (let index = 0; index < 16; index++) {
        const started = performance.now()
        const session = await PluginSession.create(sources(pluginCount), {
          state: new PluginState({ directory })
        })
        const elapsed = performance.now() - started
        try {
          assert.equal(session.descriptors.length, pluginCount)
          if (pluginCount === 1) {
            const callStarted = performance.now()
            const value = await session.dispatch('beforeModel', context, {
              messages: initialMessages,
              stepNumber: 0
            })
            const callElapsed = performance.now() - callStarted
            assert.deepEqual(value!.messages, initialMessages)
            if (index > 0) firstContext.push(callElapsed)
          }
        } finally {
          await session.dispose()
        }
        if (index > 0) values.push(elapsed)
      }
      samples.push({ name: `worker-start-${pluginCount}-plugins`, unit: 'ms', values })
    }
    samples.push({ name: 'context-1024KiB-first-call', unit: 'ms', values: firstContext })
    const cases: Case[] = []
    for (const pluginCount of [1, 5]) {
      cases.push({
        name: `text-delta-32B-${pluginCount}-plugins`,
        count: pluginCount,
        hook: 'textDelta',
        event: { text: 'x'.repeat(32), stepNumber: 0 },
        iterations: 500,
        verify: (value) => assert.deepEqual(value, { text: 'x'.repeat(32) })
      })
    }
    for (const [bytes, pluginCount] of [
      [16 * 1024, 1],
      [128 * 1024, 1],
      [1024 * 1024, 1],
      [128 * 1024, 5]
    ]) {
      const messages = contextMessages(bytes)
      cases.push({
        name: `context-${bytes / 1024}KiB-${pluginCount}-plugins`,
        count: pluginCount,
        hook: 'beforeModel',
        event: { messages, stepNumber: 0 },
        iterations: bytes >= 1024 * 1024 ? 60 : 150,
        verify(value) {
          const result = value as { messages: typeof messages }
          assert.equal(result.messages.length, messages.length)
          assert.equal(result.messages.at(-1)!.content, messages.at(-1)!.content)
        }
      })
    }
    const rewritten = contextMessages(1024 * 1024)
    cases.push({
      name: 'rewrite-1024KiB-1-plugins',
      count: 1,
      hook: 'beforeModel',
      source: `export default {apiVersion: 1, hooks: {beforeModel({messages}) {
        return {messages: messages.map(message => ({...message, content: message.content.toUpperCase()}))}
      }}}`,
      event: { messages: rewritten, stepNumber: 0 },
      iterations: 60,
      verify(value) {
        const result = value as { messages: typeof rewritten }
        assert.equal(result.messages.length, rewritten.length)
        assert.equal(result.messages.at(-1)!.content, rewritten.at(-1)!.content.toUpperCase())
      }
    })
    const binary = new Uint8Array(1024 * 1024).fill(73)
    cases.push({
      name: 'binary-1024KiB-1-plugins',
      count: 1,
      hook: 'beforeModel',
      event: {
        messages: [
          { role: 'user', content: [{ type: 'file', data: binary, mediaType: 'application/pdf' }] }
        ],
        stepNumber: 0
      },
      iterations: 60,
      verify(value) {
        const result = value as { messages: { content: { data: Uint8Array }[] }[] }
        const bytes = result.messages[0].content[0].data
        assert(bytes instanceof Uint8Array)
        assert.equal(bytes.length, binary.length)
        assert.equal(bytes.at(-1), 73)
      }
    })
    for (const scope of ['run', 'thread']) {
      cases.push({
        name: `state-read-write-${scope}`,
        count: 1,
        source: stateSource,
        hook: 'beforeInput',
        event: { text: scope },
        iterations: scope === 'run' ? 200 : 50,
        verify: (value, index) => assert.deepEqual(value, { text: String(index + 1) })
      })
    }
    const text = 'abcd'.repeat(32 * 1024)
    const expected = checksum(text)
    cases.push({
      name: 'js-scan-128KiB',
      count: 1,
      hook: 'beforeInput',
      event: { text },
      iterations: 100,
      source: `${checksum.toString()}; export default {apiVersion: 1, hooks: {beforeInput({text}) {return {text: checksum(text)}}}}`,
      verify: (value) => assert.deepEqual(value, { text: expected })
    })
    for (const item of cases) {
      const session = await PluginSession.create(sources(item.count, item.source), {
        state: new PluginState({ directory: join(directory, item.name) })
      })
      try {
        const values: number[] = []
        for (let index = 0; index < item.iterations + 30; index++) {
          const started = performance.now()
          const value = await session.dispatch(item.hook, context, item.event)
          const elapsed = performance.now() - started
          item.verify(value, index)
          if (index >= 30) values.push(elapsed)
        }
        samples.push({ name: item.name, unit: 'ms', values })
      } finally {
        await session.dispose()
      }
    }
    console.log(JSON.stringify(samples))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

function summarize(values: number[]): {
  n: number
  p50: number
  p95: number
  mean: number
  max: number
} {
  const sorted = [...values].sort((a, b) => a - b)
  return {
    n: sorted.length,
    p50: sorted[Math.ceil(sorted.length * 0.5) - 1],
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
    mean: sorted.reduce((a, b) => a + b, 0) / sorted.length,
    max: sorted.at(-1)!
  }
}

async function main(): Promise<void> {
  const options = new Map<string, string>()
  for (let index = 2; index < process.argv.length; index += 2) {
    const key = process.argv[index]
    const value = process.argv[index + 1]
    assert(
      ['--baseline', '--out', '--rounds'].includes(key) && value,
      'Usage: plugin-runtime-benchmark.mts [--baseline REF] [--out PATH] [--rounds N]'
    )
    options.set(key, value)
  }
  const rounds = Number(options.get('--rounds') ?? 3)
  assert(Number.isInteger(rounds) && rounds >= 1 && rounds <= 10)
  const output = resolve(
    options.get('--out') ?? join(tmpdir(), 'yachiyo-plugin-runtime-results.json')
  )
  const directory = await mkdtemp(join(tmpdir(), 'yachiyo-plugin-benchmark-'))
  const require = createRequire(join(root, 'apps/headless/package.json'))
  const { build } = require('esbuild') as typeof import('esbuild')
  const revisions = [
    {
      name: 'current',
      source: root,
      commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
    }
  ]
  const environment = {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    os: release(),
    cpu: cpus()[0].model,
    cores: cpus().length,
    ramGiB: totalmem() / 1024 ** 3,
    loadStart: loadavg(),
    measuredAt: new Date().toISOString()
  }
  try {
    const baseline = options.get('--baseline')
    if (baseline) {
      const commit = execFileSync('git', ['rev-parse', '--verify', `${baseline}^{commit}`], {
        cwd: root,
        encoding: 'utf8'
      }).trim()
      const archive = execFileSync(
        'git',
        ['archive', commit, 'packages/runtime/src', 'packages/shared/src'],
        { cwd: root, maxBuffer: 128 * 1024 * 1024 }
      )
      const source = join(directory, 'baseline-source')
      await mkdir(source)
      execFileSync('tar', ['-x', '-C', source], { input: archive })
      revisions.unshift({ name: 'baseline', source, commit })
    }
    await symlink(
      join(root, 'packages/runtime/node_modules'),
      join(directory, 'node_modules'),
      'dir'
    )
    const bundles = new Map<string, string>()
    for (const revision of revisions) {
      const pluginDir = join(revision.source, 'packages/runtime/src/services/plugins')
      const out = join(directory, revision.name)
      await mkdir(out)
      const entry = join(out, 'entry.ts')
      await writeFile(
        entry,
        `export {PluginSession} from ${JSON.stringify(join(pluginDir, 'pluginSession.ts'))}; export {PluginState} from ${JSON.stringify(join(pluginDir, 'pluginState.ts'))}`
      )
      await build({
        entryPoints: {
          session: entry,
          ...(existsSync(join(pluginDir, 'pluginWorker.ts'))
            ? { pluginWorker: join(pluginDir, 'pluginWorker.ts') }
            : {})
        },
        outdir: out,
        outExtension: { '.js': '.mjs' },
        bundle: true,
        platform: 'node',
        target: 'node22',
        format: 'esm',
        packages: 'external',
        plugins: [
          {
            name: 'benchmark-worker-location',
            setup(builder) {
              builder.onLoad(
                { filter: /[\\/]services[\\/]plugins[\\/]pluginWorkerPath\.ts$/ },
                () => ({
                  contents: `export const pluginWorkerPath = new URL('./pluginWorker.mjs', import.meta.url)`,
                  loader: 'js'
                })
              )
              builder.onResolve({ filter: /^@yachiyo\/shared\// }, (args) => ({
                path: join(
                  revision.source,
                  'packages/shared/src',
                  args.path.slice('@yachiyo/shared/'.length) + '.ts'
                )
              }))
            }
          }
        ]
      })
      bundles.set(revision.name, join(out, 'session.mjs'))
    }
    const results = new Map<string, Sample[]>()
    for (const revision of revisions) results.set(revision.name, [])
    for (let round = 0; round < rounds; round++) {
      const order = round % 2 ? [...revisions].reverse() : revisions
      for (const revision of order) {
        console.error(`Round ${round + 1}/${rounds}: ${revision.name}`)
        const run = spawnSync(
          process.execPath,
          [
            '--experimental-strip-types',
            fileURLToPath(import.meta.url),
            '--child',
            bundles.get(revision.name)!,
            'latency',
            '1'
          ],
          { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 120_000 }
        )
        assert.equal(run.status, 0, run.stderr || String(run.error))
        results.get(revision.name)!.push(...JSON.parse(run.stdout))
      }
    }
    for (const revision of revisions) {
      for (const [mode, count] of [
        ['memory', 1],
        ['memory', 5],
        ['memory', 10],
        ['memory-context', 1],
        ['memory-context', 5]
      ] as const) {
        for (let index = 0; index < 3; index++) {
          const run = spawnSync(
            process.execPath,
            [
              '--expose-gc',
              '--experimental-strip-types',
              fileURLToPath(import.meta.url),
              '--child',
              bundles.get(revision.name)!,
              mode,
              String(count)
            ],
            { encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 30_000 }
          )
          assert.equal(run.status, 0, run.stderr || String(run.error))
          results.get(revision.name)!.push(...JSON.parse(run.stdout))
        }
      }
    }
    const engines = revisions.map((revision) => ({
      name: revision.name,
      commit: revision.commit,
      workingTreeChanges:
        revision.source === root
          ? execFileSync(
              'git',
              ['status', '--porcelain', '--', 'packages/runtime/src/services/plugins'],
              { cwd: root, encoding: 'utf8' }
            )
              .trim()
              .split('\n')
              .filter(Boolean)
          : [],
      metrics: [...new Set(results.get(revision.name)!.map((sample) => sample.name))].map(
        (name) => {
          const samples = results.get(revision.name)!.filter((sample) => sample.name === name)
          const values = samples.flatMap((sample) => sample.values)
          return { name, unit: samples[0].unit, ...summarize(values), samples: values }
        }
      )
    }))
    await writeFile(
      output,
      JSON.stringify(
        {
          environment: { ...environment, loadEnd: loadavg() },
          methodology: {
            rounds,
            build: 'esbuild node22 ESM, external packages, same worker layout as headless',
            startup:
              'fresh workers in a running host; first sample per batch excluded; OS caches not flushed',
            steady:
              'serial dispatch including worker IPC, plugin execution, and host result validation; 30 warmup calls per case',
            memory:
              'process RSS increase after startup and 100 small hooks; context variants also execute 20 hooks with 1 MiB of text; fresh process per sample, 3 samples per case, host GC before snapshots',
            exclusions:
              'no provider, network, renderer, tool execution or real conversation data; contexts use 64 distinct ASCII message bodies; sizes exclude message envelopes'
          },
          engines
        },
        null,
        2
      ) + '\n'
    )
    for (const engine of engines)
      console.table(
        engine.metrics.map(({ name, unit, n, p50, p95 }) => ({
          engine: engine.name,
          name,
          unit,
          n,
          p50: p50.toFixed(3),
          p95: p95.toFixed(3)
        }))
      )
    console.log(`Results: ${output}`)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

if (process.argv[2] === '--child')
  await child(process.argv[3], process.argv[4], Number(process.argv[5]))
else await main()
