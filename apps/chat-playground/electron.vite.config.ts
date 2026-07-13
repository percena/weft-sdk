import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))

/**
 * Electron build config (main + preload + renderer).
 *
 * - main (Node): owns the local Coding Agent runtime via @percena/weft-node/runtime,
 *   externalized so it loads from node_modules at runtime (workspace dist).
 * - preload: contextBridge IPC surface; only `electron` is externalized.
 * - renderer: the existing React chat UI, now importing @percena/weft-node.
 *
 * Both main and preload are ESM (the package is `"type": "module"`); Electron 28+
 * supports ESM main, and an `.mjs` preload is the supported ESM-preload form.
 */
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(root, 'electron/main.ts') },
        output: { format: 'es', entryFileNames: '[name].js' },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(root, 'electron/preload.ts') },
        output: { format: 'es', entryFileNames: '[name].mjs' },
      },
    },
  },
  renderer: {
    root: root,
    plugins: [react(), tailwindcss()],
    resolve: {
      preserveSymlinks: true,
      dedupe: ['react', 'react-dom', 'i18next', 'react-i18next'],
    },
    build: {
      chunkSizeWarningLimit: 1200,
      rollupOptions: {
        input: { index: resolve(root, 'index.html') },
        onwarn(warning, warn) {
          if (warning.code === 'MODULE_LEVEL_DIRECTIVE') return
          if (
            warning.code === 'PLUGIN_WARNING' &&
            warning.plugin === 'vite:resolve' &&
            warning.message?.includes('externalized for browser compatibility')
          ) return
          warn(warning)
        },
        output: {
          // The chat panel (shiki/markdown/motion) ships pre-bundled inside
          // @percena/weft-node/chat, so only split React into its own chunk.
          manualChunks: {
            react: ['react', 'react-dom'],
          },
        },
      },
    },
    server: {
      port: 5173,
      host: '127.0.0.1',
    },
  },
})
