import { build } from 'esbuild'
import { access, chmod, cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const app = dirname(fileURLToPath(import.meta.url))
const root = resolve(app, '../..')
const out = join(app, 'dist')
const platform = process.platform === 'darwin' ? 'mac' : process.platform
const binaries =
  process.env.YACHIYO_HEADLESS_BIN_DIR ??
  join(root, 'apps/desktop/resources/bin', `${platform}-${process.arch}`)

// Native helpers are supplied separately. This build never changes the workspace's Electron ABI.
for (const name of ['process-host', 'sync-core']) {
  await access(join(binaries, name), constants.R_OK | constants.X_OK).catch(() => {
    throw new Error(
      `Missing ${name} in ${binaries}. Supply prebuilt helpers via YACHIYO_HEADLESS_BIN_DIR.`
    )
  })
}

await mkdir(out, { recursive: true })
const workspacePlugin = {
  name: 'yachiyo-workspace',
  setup(builder) {
    builder.onResolve({ filter: /^@yachiyo\// }, ({ path }) => {
      const [, name, ...rest] = path.split('/')
      if (!['runtime', 'shared', 'cli'].includes(name) || rest.length === 0) {
        throw new Error(`Unsupported workspace import: ${path}`)
      }
      return { path: join(root, 'packages', name, 'src', rest.join('/') + '.ts') }
    })
  }
}

await build({
  entryPoints: {
    main: join(app, 'src/main.ts'),
    jsReplWorker: join(root, 'packages/runtime/src/tools/agentTools/jsReplWorker.ts')
  },
  outdir: out,
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  packages: 'external',
  plugins: [workspacePlugin],
  sourcemap: true
})

const manifest = JSON.parse(await readFile(join(app, 'package.json'), 'utf8'))
const dependencies = {}
for (const name of ['runtime', 'shared', 'cli']) {
  const pkg = JSON.parse(await readFile(join(root, 'packages', name, 'package.json'), 'utf8'))
  for (const [dependency, version] of Object.entries(pkg.dependencies)) {
    if (!dependency.startsWith('@yachiyo/')) dependencies[dependency] = version
  }
}
await writeFile(
  join(out, 'package.json'),
  JSON.stringify(
    {
      name: 'yachiyo-headless',
      version: manifest.version,
      private: true,
      type: 'module',
      engines: { node: '22.22.1' },
      bin: { yachiyo: './yachiyo' },
      dependencies
    },
    null,
    2
  ) + '\n'
)
await cp(join(root, 'packages/runtime/src/storage/sqlite/drizzle'), join(out, 'drizzle'), {
  recursive: true
})
await cp(
  join(root, 'packages/runtime/src/tools/agentTools/pyReplRunner.py'),
  join(out, 'pyReplRunner.py')
)
await mkdir(join(out, 'bin'), { recursive: true })
for (const name of ['process-host', 'sync-core'])
  await cp(join(binaries, name), join(out, 'bin', name))
await cp(join(root, 'packages/core-skills/core-skills'), join(out, 'core-skills'), {
  recursive: true
})
for (const name of ['LICENSE', 'NOTICE']) await cp(join(root, name), join(out, name))
await cp(join(app, 'README.md'), join(out, 'README.md'))
await cp(join(app, 'yachiyo.service'), join(out, 'yachiyo.service'))
await writeFile(join(out, 'yachiyo'), '#!/bin/sh\nexec node "$(dirname "$0")/main.mjs" "$@"\n')
await chmod(join(out, 'yachiyo'), 0o755)
console.log(
  `Headless distribution written to ${out}. Install its Node dependencies on the target host.`
)
