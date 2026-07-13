import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    preserveSymlinks: true,
    dedupe: ['react', 'react-dom', 'i18next', 'react-i18next'],
  },
  build: {
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
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
        // @percena/weft/chat, so only split React into its own chunk here.
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
})
