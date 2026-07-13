# @percena/weft-node

> **Weaving agents into your app.**

Weft is an embeddable **agent chat runtime SDK** — drop a streaming chat panel
into your app and let an agent drive your REST API through named tools, respect
your state machine, and visually replay each call. `@percena/weft-node` is the
**Node.js / desktop** entry of the [Weft](https://github.com/percena/weft-sdk)
SDK.

> **Upcoming — not yet production-ready.** The browser package
> [`@percena/weft`](https://www.npmjs.com/package/@percena/weft) is the
> production-ready path today.

`@percena/weft-node` ships the same chat panel and timeline types as
`@percena/weft`, plus the Node-only surfaces: the Claude and Codex provider
runtimes, config-driven provider selection, skills / sources / automations, the
tool-permission policy, and the CLI-subprocess fallback runtime. It is **not**
browser-safe — it imports `node:child_process` and other Node built-ins.

For browser / web apps, use
[`@percena/weft`](https://www.npmjs.com/package/@percena/weft) instead.

## Install

```bash
npm install @percena/weft-node react react-dom
```

Install `@anthropic-ai/claude-agent-sdk@^0.3.207` only when using the native
Claude runtime or `@percena/weft-node/providers/claude/sdk`; Codex-only hosts
and Claude CLI fallback do not require it. The callback-capable Codex runtime
uses Codex app-server directly; its SDK version is verified in this repository,
not imposed on package consumers.

## Entry points

| Subpath | What it exports |
| --- | --- |
| `@percena/weft-node` | Core runtime + timeline types, `useAgentSession`, `TimelineAgentChatPanel`, `EN_FALLBACK` |
| `@percena/weft-node/chat` | Full streaming chat panel (`TimelineAgentChatPanel`, hooks, i18n fallback) |
| `@percena/weft-node/providers/claude` | Claude Agent SDK runtime + CLI fallback |
| `@percena/weft-node/providers/claude/sdk` | Optional Claude Agent SDK session and MCP helpers |
| `@percena/weft-node/providers/codex` | Codex app-server runtime + CLI fallback |
| `@percena/weft-node/providers/flitro` | Flitro embed runtime (also available in the browser package) |
| `@percena/weft-node/runtime` | Config-driven provider selection (`createHostAgentRuntime`) |
| `@percena/weft-node/cli-runtime` | CLI-subprocess baseline + projectors |
| `@percena/weft-node/skills` | Skill metadata |
| `@percena/weft-node/sources` | Source / MCP management |
| `@percena/weft-node/automations` | Automation engine |
| `@percena/weft-node/policy` | Tool-permission policy |
| `@percena/weft-node/styles` | Precompiled chat-panel CSS (`import '@percena/weft-node/styles'`) |

For the runtime contract, provider selection, and the full architecture, see the
[repo README](https://github.com/percena/weft-sdk) +
[`docs/ARCHITECTURE.md`](https://github.com/percena/weft-sdk/blob/main/docs/ARCHITECTURE.md).

## License

MIT © Percena
