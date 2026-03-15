import { resolve } from 'path'
import { cpSync, mkdirSync } from 'fs'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

function copyDrizzleMigrations(): { name: string; closeBundle: () => void } {
  return {
    name: 'copy-drizzle-migrations',
    closeBundle() {
      const src = resolve('src/main/yachiyo-server/drizzle')
      const dest = resolve('out/main/drizzle')
      mkdirSync(dest, { recursive: true })
      cpSync(src, dest, { recursive: true })
    }
  }
}

export default defineConfig({
  main: {
    plugins: [copyDrizzleMigrations()]
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
          settings: resolve('src/renderer/settings/index.html')
        }
      }
    },
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [react(), tailwindcss()]
  }
})
