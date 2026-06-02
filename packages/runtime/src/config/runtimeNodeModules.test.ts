import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { resolveRuntimeNodeModule } from './runtimeNodeModules.ts'

function setResourcesPath(resourcesPath: string): () => void {
  const originalDescriptor = Object.getOwnPropertyDescriptor(process, 'resourcesPath')
  Object.defineProperty(process, 'resourcesPath', {
    configurable: true,
    value: resourcesPath
  })

  return () => {
    if (originalDescriptor) {
      Object.defineProperty(process, 'resourcesPath', originalDescriptor)
      return
    }

    Reflect.deleteProperty(process, 'resourcesPath')
  }
}

test('runtime node module resolver prefers packaged Resources node_modules', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-runtime-node-modules-'))
  const packageRoot = join(root, 'node_modules', 'better-sqlite3')
  const restoreResourcesPath = setResourcesPath(root)

  try {
    await mkdir(packageRoot, { recursive: true })
    await writeFile(join(packageRoot, 'package.json'), '{"name":"better-sqlite3"}')

    const fallbackRequire = {
      resolve() {
        throw new Error('fallback resolver should not be used')
      }
    } as unknown as NodeJS.Require

    assert.equal(resolveRuntimeNodeModule('better-sqlite3', fallbackRequire), packageRoot)
  } finally {
    restoreResourcesPath()
    await rm(root, { recursive: true, force: true })
  }
})

test('runtime node module resolver falls back to the importing module resolver', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-runtime-node-modules-empty-'))
  const restoreResourcesPath = setResourcesPath(root)

  try {
    const fallbackRequire = {
      resolve(specifier: string) {
        return `/fallback/${specifier}`
      }
    } as unknown as NodeJS.Require

    assert.equal(
      resolveRuntimeNodeModule('better-sqlite3', fallbackRequire),
      '/fallback/better-sqlite3'
    )
  } finally {
    restoreResourcesPath()
    await rm(root, { recursive: true, force: true })
  }
})
