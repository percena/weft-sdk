import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    flitro: 'src/flitro/index.ts',
    claude: 'src/claude/index.ts',
    codex: 'src/codex/index.ts',
    factory: 'src/factory/index.ts',
    shared: 'src/shared/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: { tsconfig: 'tsconfig.build.json' },
  clean: true,
  sourcemap: true,
  external: [/^@weft\//, '@anthropic-ai/claude-agent-sdk'],
})
