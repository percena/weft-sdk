import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    'index': 'src/index.ts',
    'chat': 'src/chat.ts',
    'providers-claude': 'src/providers-claude.ts',
    'providers-claude-sdk': 'src/providers-claude-sdk.ts',
    'providers-codex': 'src/providers-codex.ts',
    'runtime': 'src/runtime.ts',
    'cli-runtime': 'src/cli-runtime.ts',
    'skills': 'src/skills.ts',
    'sources': 'src/sources.ts',
    'automations': 'src/automations.ts',
    'policy': 'src/policy.ts',
  },
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: false,
  // SDK-5: code-split the ESM output so shared @weft/* deps land in shared
  // chunks instead of being duplicated into each of the 11 entries. See
  // publish/browser/tsup.config.ts for the full rationale. ESM-only
  // (matches @percena/weft): dropping CJS removes the duplicate
  // standalone CJS entries entirely, and Node consumers already use `import`.
  splitting: true,
  noExternal: [/^@weft\//],
  external: [
    'react',
    'react-dom',
    'react/jsx-runtime',
    'i18next',
    'react-i18next',
    '@anthropic-ai/claude-agent-sdk',
  ],
})
