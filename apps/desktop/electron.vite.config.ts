import { dirname, resolve } from 'path'
import { cpSync, mkdirSync, rmSync } from 'fs'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

function copyDrizzleMigrations(includeDevAssets: boolean): {
  name: string
  closeBundle: () => void
} {
  return {
    name: 'copy-drizzle-migrations',
    closeBundle() {
      const src = resolve('../../packages/runtime/src/storage/sqlite/drizzle')
      const mainDestination = resolve('out/main/drizzle')
      const destinations = [resolve('out/main/chunks/drizzle')]
      if (includeDevAssets) {
        destinations.push(mainDestination)
      } else {
        rmSync(mainDestination, { recursive: true, force: true })
      }
      for (const dest of destinations) {
        rmSync(dest, { recursive: true, force: true })
        mkdirSync(dest, { recursive: true })
        cpSync(src, dest, {
          recursive: true,
          filter: (source) => !source.endsWith('_snapshot.json')
        })
      }
    }
  }
}

function copyCoreSkills(): { name: string; closeBundle: () => void } {
  return {
    name: 'copy-core-skills',
    closeBundle() {
      const src = resolve('../../packages/core-skills/core-skills')
      const dest = resolve('out/main/core-skills')
      mkdirSync(dest, { recursive: true })
      cpSync(src, dest, { recursive: true })
    }
  }
}

const runtimeNodeModulesBanner = `
try {
  const path = require('path');
  const Module = require('module');
  const runtimeNodeModules = path.join(process.resourcesPath || '', 'node_modules');
  if (runtimeNodeModules && !Module.globalPaths.includes(runtimeNodeModules)) {
    process.env.NODE_PATH = process.env.NODE_PATH
      ? runtimeNodeModules + path.delimiter + process.env.NODE_PATH
      : runtimeNodeModules;
    Module._initPaths();
  }
} catch {}
`

function copyJiebaWasm(includeDevAssets: boolean): { name: string; closeBundle: () => void } {
  return {
    name: 'copy-jieba-wasm',
    closeBundle() {
      const src = resolve('node_modules/jieba-wasm/pkg/nodejs/jieba_rs_wasm_bg.wasm')
      const mainDestination = resolve('out/main/jieba_rs_wasm_bg.wasm')
      const destinations = [resolve('out/main/chunks/jieba_rs_wasm_bg.wasm')]
      if (includeDevAssets) {
        destinations.push(mainDestination)
      } else {
        rmSync(mainDestination, { force: true })
      }
      for (const dest of destinations) {
        mkdirSync(dirname(dest), { recursive: true })
        cpSync(src, dest)
      }
    }
  }
}

export default defineConfig(({ command }) => ({
  main: {
    resolve: {
      alias: {
        canvas: resolve('src/main/shims/canvas.ts'),
        'node-fetch': resolve('src/main/shims/node-fetch.ts')
      }
    },
    build: {
      externalizeDeps: false,
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          'runtime-host': resolve('src/main/runtimeHost/runtimeHostMain.ts'),
          ...(command === 'serve'
            ? { 'runtime-host-spike': resolve('src/main/runtimeHost/spikeUtilityMain.ts') }
            : {})
        },
        external: ['better-sqlite3', 'sharp', 'zlib-sync', 'bufferutil', 'utf-8-validate'],
        output: {
          banner: runtimeNodeModulesBanner
        }
      }
    },
    plugins: [
      copyDrizzleMigrations(command === 'serve'),
      ...(command === 'serve' ? [copyCoreSkills()] : []),
      copyJiebaWasm(command === 'serve')
    ]
  },
  preload: {},
  renderer: {
    server: {
      host: '127.0.0.1',
      port: 5173,
      strictPort: true
    },
    build: {
      rollupOptions: {
        input: {
          main: resolve('src/renderer/index.html'),
          translator: resolve('src/renderer/translator/index.html'),
          jotdown: resolve('src/renderer/jotdown/index.html')
        }
      }
    },
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@chenglou/pretext/measurement': resolve(
          'node_modules/@chenglou/pretext/dist/measurement.js'
        )
      }
    },
    plugins: [react(), tailwindcss()],
    define: {
      __APP_VERSION__: JSON.stringify(process.env.npm_package_version ?? '1.0.0')
    }
  }
}))
