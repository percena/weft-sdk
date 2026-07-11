import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Dev: Vite on :5176 proxies /api + /v1 (chat traffic) + /openapi.json to the
// FastAPI backend on :19755 (run `pnpm serve`). Prod: `pnpm start` builds the
// SPA into dist/ and run.py serves it same-origin (no proxy).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // esbuild 0.28.x errors lowering object-rest destructuring (e.g.
  // `const { a, ...rest } = x` in @percena/weft/dist + i18next) to the default
  // es2020/chrome87 target. Target esnext so esbuild doesn't attempt the
  // lowering — fine for a modern-browser demo. See online-store/agentic.
  build: { target: 'esnext', outDir: 'dist' },
  optimizeDeps: { esbuildOptions: { target: 'esnext' } },
  server: {
    host: '127.0.0.1',
    port: 5176,
    proxy: {
      '/api': 'http://127.0.0.1:19755',
      '/v1': 'http://127.0.0.1:19755',
      '/openapi.json': 'http://127.0.0.1:19755',
    },
  },
})
