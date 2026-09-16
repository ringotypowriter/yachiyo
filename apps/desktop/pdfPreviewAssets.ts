import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { readFileSync, readdirSync } from 'node:fs'
import type { Plugin } from 'vite'

// Stable local URLs are required by PDF.js's CMap/font/decoder factories, including offline.
export function pdfPreviewAssets(): Plugin {
  const root = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'))
  const assets = new Map<string, string>()
  for (const directory of ['cmaps', 'standard_fonts', 'wasm']) {
    for (const name of readdirSync(resolve(root, directory))) {
      if (/\.(bcmap|pfb|ttf|wasm|mjs|js)$/.test(name) || name.startsWith('LICENSE')) {
        assets.set(`pdfjs/${directory}/${name}`, resolve(root, directory, name))
      }
    }
  }
  return {
    name: 'pdf-preview-assets',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const path = assets.get((request.url ?? '').split('?')[0].replace(/^\//, ''))
        if (!path) return next()
        response.setHeader(
          'Content-Type',
          path.endsWith('.wasm')
            ? 'application/wasm'
            : path.endsWith('.js') || path.endsWith('.mjs')
              ? 'text/javascript'
              : 'application/octet-stream'
        )
        response.end(readFileSync(path))
      })
    },
    generateBundle() {
      for (const [fileName, path] of assets) {
        this.emitFile({ type: 'asset', fileName, source: readFileSync(path) })
      }
    }
  }
}
