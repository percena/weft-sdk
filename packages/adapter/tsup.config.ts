import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    'index': 'src/index.ts',
    'auth/index': 'src/auth/index.ts',
    'models/index': 'src/models/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: { tsconfig: 'tsconfig.build.json' },
  clean: true,
  sourcemap: true,
  external: [
    '@anthropic-ai/claude-agent-sdk',
  ],
})
