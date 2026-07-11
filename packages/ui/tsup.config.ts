import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    'index': 'src/index.ts',
    'lib/en-fallback': 'src/lib/en-fallback.ts',
  },
  format: ['esm', 'cjs'],
  dts: { tsconfig: 'tsconfig.build.json' },
  clean: true,
  sourcemap: true,
  external: [
    'react',
    'react-dom',
    'react/jsx-runtime',
    'i18next',
    'react-i18next',
  ],
})
