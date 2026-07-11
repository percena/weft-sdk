import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Dev: Vite on :5175 proxies /api + /openapi.json to the FastAPI backend on
// :19753 (run `pnpm serve` in another terminal). Prod: `pnpm start` builds the
// SPA into dist/ and uvicorn serves it same-origin (no proxy needed).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5175,
    proxy: {
      '/api': 'http://127.0.0.1:19753',
      '/openapi.json': 'http://127.0.0.1:19753',
    },
  },
  build: { outDir: 'dist' },
})
