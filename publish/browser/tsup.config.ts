import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    'index': 'src/index.ts',
    'chat': 'src/chat.ts',
    'providers-flitro': 'src/providers-flitro.ts',
    'action-bridge': 'src/action-bridge.ts',
  },
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: false,
  // SDK-5: code-split the ESM output so shared @weft/* deps (notably
  // @weft/ui — ~640 KB + a context-state instance) land in shared chunks
  // imported via RELATIVE paths from each entry, instead of being duplicated
  // INTO each entry. Pre-fix (splitting:false) every entry bundled the whole
  // @weft/* graph inline → ~640 KB dup across `.`/`./chat` + two
  // context-state instances (providers from `.` invisible to components from
  // `./chat`). ESM-only since the 1.0-track: dropping CJS also removes the
  // duplicated standalone CJS builds (~1.6 MB) and the .d.cts type mirrors.
  // Shared chunks are NOT listed in package.json#exports (imported via relative
  // paths); `files: ["dist"]` ships them.
  splitting: true,
  noExternal: [/^@weft\//],
  external: [
    'react',
    'react-dom',
    'react/jsx-runtime',
    'i18next',
    'react-i18next',
  ],
})
