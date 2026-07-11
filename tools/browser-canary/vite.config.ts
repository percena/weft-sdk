import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    // The canary intentionally imports the full browser SDK surface.
    chunkSizeWarningLimit: 1400,
    rollupOptions: {
      onwarn(warning, warn) {
        const source = `${warning.id ?? ''}\n${warning.message ?? ''}`
        if (warning.code === 'MODULE_LEVEL_DIRECTIVE' && source.includes('framer-motion')) {
          return
        }
        warn(warning)
      },
    },
  },
})
