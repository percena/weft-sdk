import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // esbuild 0.28.x errors lowering object-rest destructuring (e.g.
  // `const { a, ...rest } = x` in @percena/weft/dist + i18next) to the default
  // es2020/chrome87 target ("Transforming destructuring ... is not supported
  // yet"). Target esnext so esbuild doesn't attempt the lowering — fine for a
  // modern-browser demo. Revisit if old-browser support is needed.
  build: {
    target: 'esnext',
    chunkSizeWarningLimit: 1600,
    rollupOptions: {
      onwarn(warning, warn) {
        if (warning.code === 'MODULE_LEVEL_DIRECTIVE') return
        warn(warning)
      },
    },
  },
  optimizeDeps: { esbuildOptions: { target: 'esnext' } },
  resolve: {
    preserveSymlinks: true,
    dedupe: ['react', 'react-dom', 'i18next', 'react-i18next'],
  },
  server: {
    port: 5173,
    host: '127.0.0.1',
    fs: {
      allow: [
        fileURLToPath(new URL('.', import.meta.url)),
        fileURLToPath(new URL('./shared', import.meta.url)),
      ],
    },
    proxy: {
      '/api': {
        target: process.env.SHOP_API_URL ?? 'http://127.0.0.1:19745',
        changeOrigin: true,
      },
      '/v1': {
        target: process.env.SHOP_API_URL ?? 'http://127.0.0.1:19745',
        changeOrigin: true,
      },
    },
  },
})
