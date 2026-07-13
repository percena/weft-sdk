# Weft Node Optional SDK Hardening

## Goal

Make `@percena/weft-node` usable by Codex-only and Claude CLI-only consumers
without installing the Claude Agent SDK, while updating both provider SDK
baselines and hardening Codex app-server communication.

## Runtime boundaries

`@anthropic-ai/claude-agent-sdk` and `@openai/codex-sdk` are optional peer
dependencies. Importing `@percena/weft-node/runtime`,
`@percena/weft-node/providers/codex`, or the Claude CLI fallback must not
eagerly resolve either SDK.

Claude Agent SDK convenience exports move to
`@percena/weft-node/providers/claude/sdk`. That explicit subpath requires the
Claude SDK; the normal Claude provider keeps only lazy runtime loading.

Codex continues to use the app-server bridge because it exposes the approval
and permission callbacks Weft maps to its canonical timeline. The package
declares the latest Codex SDK as an optional peer and validates that its
installed version is usable as the compatibility baseline; it does not replace
the callback-capable app-server driver with a lower-level wrapper.

## Reliability

Codex auth detection uses request-id-aware JSON-RPC dispatch and ignores
notifications while awaiting `initialize` and `account/read` responses. The
subprocess transport installs pending request state before writing, propagates
write failures immediately, and drains a bounded stderr diagnostic buffer.

## Validation

Tests cover interleaved app-server notifications, failed writes, and isolated
consumer imports without the Claude SDK. The dependency constraints are pinned
to Claude Agent SDK `0.3.207` and Codex SDK `0.144.2`; CI-style tests exercise
the installed versions and existing opt-in real provider smoke tests remain
available.

## Non-goal

`@percena/weft-node` remains private and unpublished in this change.
