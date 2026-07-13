# Weft Node Optional SDK Hardening

## Goal

Make `@percena/weft-node` usable by Codex-only and Claude CLI-only consumers
without installing the Claude Agent SDK, while updating the Claude provider SDK
baseline and hardening Codex app-server communication.

## Runtime boundaries

`@anthropic-ai/claude-agent-sdk` is an optional peer dependency. Importing
`@percena/weft-node/runtime`, `@percena/weft-node/providers/codex`, the normal
`@percena/weft-node/providers/claude` entry, or the Claude CLI fallback must not
eagerly resolve the Claude SDK.

Claude Agent SDK convenience exports move to
`@percena/weft-node/providers/claude/sdk`. That explicit subpath requires the
Claude SDK; the normal Claude provider keeps only lazy runtime loading.

Codex continues to use the app-server bridge because it exposes the approval
and permission callbacks Weft maps to its canonical timeline; weft source never
imports `@openai/codex-sdk`, so no consumer-facing Codex peer is declared.
`@openai/codex-sdk` is kept as a development-only dependency because it
transitively installs `@openai/codex` — the `codex` CLI binary, `hasBin` — into
`node_modules/.bin/codex`, giving the opt-in real-provider smoke tests a pinned,
reproducible `codex` version instead of whatever happens to be on the
developer's global PATH.

## Reliability

Codex auth detection uses request-id-aware JSON-RPC dispatch and ignores
notifications while awaiting `initialize` and `account/read` responses; async
spawn errors and unexpected subprocess exit reject any in-flight request and
clear its timer immediately. The subprocess transport installs pending request
state before writing, propagates write failures immediately, and drains stderr
so a verbose child cannot block once its stderr pipe fills.

## Validation

Tests cover interleaved app-server notifications, failed writes, isolated
consumer imports without the Claude SDK, and the SDK-free declaration invariant
for every entry except the explicit `./providers/claude/sdk` subpath. The
Claude Agent SDK optional peer is pinned to `^0.3.207`; its own required peers
(`@anthropic-ai/sdk`, `@modelcontextprotocol/sdk`, `zod`) are installed for
development. `@openai/codex-sdk@0.144.2` is pinned as a dev dependency so its
transitive `@openai/codex` binary is the exact `codex` version the opt-in
real-provider smoke tests run against.

## Non-goal

`@percena/weft-node` remains private and unpublished in this change.
