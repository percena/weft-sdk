# @percena/weft

> **Weaving agents into your app.**

Weft is an embeddable **agent chat runtime SDK**. Drop a streaming chat panel into
your app, and the agent can drive your REST API through named tools, respect your
state machine, and visually replay each call on the page with live cursor
automation.

`@percena/weft` is the **browser-safe, production-ready** entry of the
[Weft](https://github.com/percena/weft-sdk) SDK. It ships the canonical-timeline
streaming chat panel, the Flitro embed runtime, and the action-bridge (agent
action replay) as a single package you can drop into any React 18.2+ web app (React 19 supported) — with
**zero Node.js dependencies** (no Vite aliases, stubs, or `process` shims
required).

For Node.js / desktop runtimes (Claude Agent SDK, Codex app-server, skills,
sources, automations), use the companion package `@percena/weft-node` (see
[the repo](https://github.com/percena/weft-sdk#desktop-with-percenaweft-node)).

> **Control-plane dependency.** The browser SDK ships the chat panel, the
> timeline, and the action-bridge. Its embed runtime
> (`@percena/weft/providers/flitro`, "Flitro") connects the panel to the
> hosted **Weft control plane** (`weftd`) — a service operated by Percena that
> provisions the agent app, mints scoped session tokens, and brokers the LLM
> run/timeline stream. This package ships the SDK; the `weftd` control plane is
> the hosted service above. Your backend bootstraps a session via `weftd`'s
> `POST /v1/sessions` (developer credential, server-side only) and hands the
> browser a scoped `{ session_id, token, base_url }` it cannot widen.

## Install

```bash
npm install @percena/weft react react-dom
```

React ≥ 18.2 is a peer dependency (React 19 is supported; React 18.2+ works for
apps not yet on 19 — the SDK uses no React-19-only APIs).

## Minimal embed example

```tsx
import '@percena/weft/styles'
import { TimelineAgentChatPanel, useAgentSession } from '@percena/weft/chat'
import { createFlitroEmbedRuntime } from '@percena/weft/providers/flitro'

function Chat({ session }: { session: { session_id: string; token: string; base_url: string } }) {
  const { runtime } = useAgentSession({
    sessionId: session.session_id,
    provider: 'flitro',
    createRuntime: () =>
      createFlitroEmbedRuntime({
        baseUrl: session.base_url,
        token: session.token,
        sessionId: session.session_id,
      }),
  })

  return <TimelineAgentChatPanel runtime={runtime} placeholder="How can I help?" />
}
```

The host backend bootstraps the session via weftd's
`POST /v1/sessions` (developer credential) and hands
`{ session_id, token, base_url }` to the browser; the scoped token cannot be
widened by the client.

## Entry points

| Subpath | What it exports |
| --- | --- |
| `@percena/weft` | Core runtime + timeline types, `useAgentSession`, `TimelineAgentChatPanel`, `createFlitroEmbedRuntime`, `EN_FALLBACK` |
| `@percena/weft/chat` | Full streaming chat panel (`TimelineAgentChatPanel`, hooks, i18n fallback) |
| `@percena/weft/providers/flitro` | Browser-safe Flitro embed runtime (pure `fetch` + SSE) |
| `@percena/weft/action-bridge` | `weftAction(...)` annotations + `ActionReplayLayer` automated-live-cursor replay |
| `@percena/weft/styles` | Precompiled chat-panel CSS incl. KaTeX math (`import '@percena/weft/styles'`) |
| `@percena/weft/styles/core` | Math-free panel CSS — opt in to skip the ~296 KB of KaTeX woff2 fonts when you don't render math (`import '@percena/weft/styles/core'`) |

## Turn a classic REST app agentic

The SDK gives you the chat panel and the timeline runtime. The
**`integrate-weft-kit`** agent skill is what turns a traditional REST app into an
agentic one: given an existing REST API with an OpenAPI spec, it layers a Weft
chat panel on top whose agent drives your API through named tools
(`<toolset>_<operationId>`, executed same-origin with the user's cookie), with
the state machine as the reactive backstop (`409 { error, allowed_actions }` →
relay + recover) and the action-bridge replaying each call on the UI.

```sh
npx skills add percena/weft-sdk --skill integrate-weft-kit
```

Proven end-to-end on two reference demos — `apps/online-store` (Node) and
`apps/itsm` (Python/FastAPI), both built by the skill from their `classic/`
counterparts. See the [repo README](https://github.com/percena/weft-sdk#demos)
for the full vertical-SaaS story.

## Browser purity

The browser bundle contains **zero `node:*` imports** — enforced in the
publish pipeline by `assert-exports.mjs` and the `browser-canary` CI app. Any
leak is a P0 bug.

## License

MIT © Percena
