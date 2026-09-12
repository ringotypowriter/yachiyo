import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  root: fileURLToPath(new URL('./src/renderer', import.meta.url)),
  resolve: {
    alias: {
      '@renderer': fileURLToPath(new URL('./src/renderer/src', import.meta.url)),
      '@chenglou/pretext/measurement': fileURLToPath(
        new URL('./node_modules/@chenglou/pretext/dist/measurement.js', import.meta.url)
      )
    }
  },
  define: { __APP_VERSION__: JSON.stringify('avatar-preview') },
  plugins: [react(), tailwindcss()],
  optimizeDeps: { entries: ['avatar-preview/index.html', 'avatar-preview/conversation.html'] },
  server: { host: '127.0.0.1', port: 5191, strictPort: true }
})
