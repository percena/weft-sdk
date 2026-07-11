import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts', 'src/browser.ts'],
  format: ['esm', 'cjs'],
  dts: { tsconfig: 'tsconfig.build.json' },
  clean: true,
  sourcemap: true,
})
