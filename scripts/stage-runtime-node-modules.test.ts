import assert from 'node:assert/strict'
import test from 'node:test'

// @ts-expect-error plain .mjs script module without type declarations
import { findRuntimePackageSpecifiers } from './stage-runtime-node-modules.mjs'

test('runtime staging discovers literal package loads across emitted bundle forms', () => {
  const source = `
    import 'esm-package'
    export { runtime } from 'reexported-package'
    export * from 'star-export-package'

    const require$1 = nodeModule.createRequire(import.meta.url)
    require$1('drizzle-orm/better-sqlite3')

    const runtimeLoader = createRequire(import.meta.url)
    runtimeLoader('@scope/runtime/subpath')

    require('sharp')
    require.resolve('resolved-package/runtime')
    module.require('legacy-package')
    createRequire(import.meta.url)('inline-package')
    createRequire(import.meta.url).resolve('inline-resolved-package')
    await import('zlib-sync')
  `

  assert.deepEqual(findRuntimePackageSpecifiers(source), [
    '@scope/runtime/subpath',
    'drizzle-orm/better-sqlite3',
    'esm-package',
    'inline-package',
    'inline-resolved-package',
    'legacy-package',
    'reexported-package',
    'resolved-package/runtime',
    'sharp',
    'star-export-package',
    'zlib-sync'
  ])
})

test('runtime staging ignores require-shaped text and unrelated functions', () => {
  const source = `
    /**
     * const { JWT } = require('google-auth-library')
     * const keys = require('/path/to/key.json')
     */
    // require('comment-package')
    const quotedExample = "require('string-package')"
    const templateExample = \`require('template-package')\`
    fakeRequire('unrelated-package')
  `

  assert.deepEqual(findRuntimePackageSpecifiers(source), [])
})
