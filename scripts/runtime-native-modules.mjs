/* eslint-disable @typescript-eslint/explicit-function-return-type */

export const RUNTIME_NATIVE_MODULES = [
  'better-sqlite3',
  'sharp',
  'bufferutil',
  'utf-8-validate',
  'zlib-sync'
]

export const ELECTRON_REBUILD_MODULES = ['better-sqlite3', 'zlib-sync']

export function buildRuntimeNativeModuleProbe(moduleRoot) {
  const loadExpression = moduleRoot
    ? `createRequire(path.join(${JSON.stringify(moduleRoot)}, 'package.json'))`
    : 'require'

  return [
    "const path = require('node:path')",
    "const { createRequire } = require('node:module')",
    `const load = ${loadExpression}`,
    'const loadNativeBinding = (packageName) => {',
    '  const packageRoot = path.dirname(load.resolve(`${packageName}/package.json`))',
    "  return createRequire(path.join(packageRoot, 'package.json'))('node-gyp-build')(packageRoot)",
    '}',
    'void (async () => {',
    "  const Database = load('better-sqlite3')",
    "  const database = new Database(':memory:')",
    '  database.close()',
    "  const sharp = load('sharp')",
    "  await sharp({ create: { width: 1, height: 1, channels: 4, background: '#00000000' } }).png().toBuffer()",
    "  const bufferutil = loadNativeBinding('bufferutil')",
    '  bufferutil.mask(Buffer.from([1]), Buffer.alloc(4), Buffer.alloc(1), 0, 1)',
    "  const isValidUtf8 = loadNativeBinding('utf-8-validate')",
    "  if (!isValidUtf8(Buffer.from('yachiyo'))) throw new Error('utf-8-validate native check failed')",
    "  load('zlib-sync')",
    "  console.log('native dependency check: all runtime modules ok')",
    '})().catch((error) => {',
    '  console.error(error instanceof Error ? error.stack : String(error))',
    '  process.exitCode = 1',
    '})'
  ].join('\n')
}
