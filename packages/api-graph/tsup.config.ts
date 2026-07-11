import { defineConfig } from 'tsup'

// Mirrors the workspace build pattern (e.g. packages/chat, publish/desktop):
// esm + cjs + dts, clean, sourcemap, splitting:false so each entry (incl. the
// cli bin) is self-contained — no runtime cross-entry import.
export default defineConfig({
  entry: { analyzer: 'src/analyzer.ts', cli: 'src/cli.ts' },
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: false,
})
