# Weft — Getting Started

> **Docs index**
> - [ARCHITECTURE.md](./ARCHITECTURE.md) — internal design, runtime contract, provider selection.
> - [SECURITY-MODEL.md](./SECURITY-MODEL.md) — integrator-facing threat model (client tools, credential boundary, XSS, CORS).
> - [EMBEDDING.md](./EMBEDDING.md) — minimal embed, session bootstrap sequence, CORS + accessibility checklists.
> - The **public API reference** is the bundled `.d.ts` shipped under `@percena/weft`
>   (`dist/*.d.ts`) + the exports table in [`publish/browser/README.md`](../publish/browser/README.md).
>   A generated TypeDoc site is planned (blocked on typedoc 0.28's `zod@^4` peer
>   resolving against the repo's zod 3, which the tightened `strict-peer-dependencies`
>   gate now catches); until then the `.d.ts` is the source of truth.

## Prerequisites

- **Node.js** ≥ 22 (runtime + test runner)
- **pnpm** ≥ 10 (package manager — see `packageManager` in root `package.json`)
- **TypeScript** ≥ 6.0 (type checking)

> The SDK itself does **not** require any environment variables — all
> configuration is done programmatically via the API. The only `.env` files are
> per-app (e.g. `apps/chat-playground/.env.example` for live-mode playground,
> `apps/online-store/agentic/.env.example` / `apps/itsm/agentic/.env.example`
> for the demo agent backends). Copy those into each app when needed.

## Installation

```bash
git clone https://github.com/percena/weft-sdk && cd weft-sdk
pnpm install
```

## Project Structure

```
weft/
├── packages/
│   ├── core/           # Core types, utilities, protocol DTOs: AgentEvent, Message, Session
│   ├── adapter/        # Claude/Codex backend abstraction: auth detection, event adapters, tool matching
│   ├── api-graph/      # API dependency-graph analyzer: fail-open DAG for LLM tool-call sequencing (internal source; shipped inside @percena/weft, not a separate package)
│   ├── timeline/       # Canonical timeline: TimelineEnvelope, cursor, replay, merge
│   ├── runtime-core/   # SDK-first AgentRuntime contract, capability report, state reducer
│   ├── providers/      # Unified provider package (claude, codex, factory, shared, embed runtime)
│   ├── policy/         # Provider-neutral permission policy, approvals, explain output
│   ├── ui/             # React rendering + event processor: TurnCard, SessionViewer, processEvent
│   ├── cli-runtime/    # Local CLI runtime: Claude/Codex JSONL adapters, session contract
│   ├── chat/           # Embeddable Chat Panel: AgentChatPanel, TimelineAgentChatPanel
│   ├── sources/        # MCP source management: SourceCredentialManager, getBuiltinSources
│   ├── skills/         # Skill definitions, storage, activation plan
│   ├── automations/    # Automation engine: conditions, cron-matcher, event-bus
│   ├── host-services/  # Host-only contracts: audit, artifacts, notifications, output governance
│   └── e2e-tests/      # End-to-end verification (runtime, providers, timeline, policy, server, demos)
├── publish/
│   ├── browser/        # @percena/weft (browser-safe facade)
│   └── desktop/        # @percena/weft-node (Node.js/desktop facade)
├── apps/
│   ├── chat-playground/  # Chat UI playground (fixture replay + live runtime)
│   ├── online-store/     # E-commerce demo: classic REST store → agentic (Node)
│   └── itsm/             # IT-service-mgmt demo: classic → agentic (Python/FastAPI)
├── skills/              # Agent skills (integrate-weft-kit) — classic → agentic conversion
├── tools/
│   └── browser-canary/   # Browser-safe import verification
├── docs/                # Architecture docs + design specs
├── pnpm-workspace.yaml  # pnpm workspace configuration
└── package.json         # Monorepo root (pnpm workspaces)
```

---

## Running Tests

```bash
pnpm run test
```

Runs all test suites via Vitest. Real-provider smoke tests are skipped by default and require explicit environment variables to enable.

### TypeScript Compilation Check

```bash
# Full repository type check
pnpm run check

# Full build (all packages in dependency order)
pnpm run build
```

---

## Demo: Chat Playground

```bash
pnpm run playground
```

Or directly:

```bash
cd apps/chat-playground
pnpm run dev
```

Open the local URL from Vite output (default `http://127.0.0.1:5173`). The app starts in **Fixture mode** — click Start to replay a pre-built timeline. Auto-play via query string:

```
http://127.0.0.1:5173/?autoplay=1
```

**Live mode** connects to a real runtime host. Configure the runtime URL via `.env`:

```bash
cp apps/chat-playground/.env.example apps/chat-playground/.env
# Edit VITE_RUNTIME_URL to point to your runtime host
```

Then switch to the Live tab in the UI, select a provider, enter a working directory, and connect. The browser-safe `RuntimeClient` creates a session via `POST /sessions`, opens a WebSocket to `/sessions/:sessionId/stream`, and uses HTTP timeline catchup to fill gaps after reconnection.

> Fixture mode needs no `.env` — it works out of the box with mock data.

---

## Demo: Online Store

A full-stack demo showcasing Weft Chat × visualized CRUD workflows. The AI agent drives the storefront's REST API and an automated live cursor replays each step.

```bash
cd apps/online-store/agentic
cp .env.example .env   # Configure remote agent server + LLM credentials
pnpm start              # Builds frontend + starts shop server on :19745
```

See `apps/online-store/README.md` for details.

---

## Streaming Chat Architecture

Weft's streaming chat uses a pure-function pipeline from the canonical timeline to the UI:

```
Provider SDK/app-server/CLI event
  → TimelineEnvelope
  → mapTimelineEnvelopeToProcessorEvent()
  → processEvent()
  → SessionState / Message[]
  → groupMessagesByTurn()
  → TurnCard / PermissionRequestCard / TimelineAgentChatPanel
```

All processor functions and EventSource implementations are exported from `@percena/weft/chat` (they live in the internal UI layer — there is no separate processor package).

---

## Integration Pattern 1: Timeline-Based (Recommended)

The timeline-based approach connects a `TimelineAgentChatPanel` directly to an `AgentRuntime`. This is the primary integration path used by both demos.

### Browser (embed runtime)

```tsx
import { useAgentSession, TimelineAgentChatPanel } from '@percena/weft/chat'
import '@percena/weft/styles'

function ChatPane({ sessionId, createRuntime }) {
  const session = useAgentSession({ sessionId, createRuntime })
  return <TimelineAgentChatPanel runtime={session.runtime} />
}
```

`createRuntime` returns an embed runtime that connects the panel to your agent backend over chat/SSE. The factory takes `baseUrl`, `token`, `sessionId`, and an optional `onTokenExpired` for token refresh — the concrete wiring is shown in the demos (see `apps/online-store/agentic/src/App.tsx`).

### Desktop / Node.js (Claude / Codex)

> **Upcoming — not yet published.** `@percena/weft-node` is the desktop/VPS in-process host runtime (not on npm, not production-ready). The code below is the intended API for when it ships. For the production-ready browser path today, see [Browser (embed runtime)](#browser-embed-runtime) above.

```tsx
import { useAgentSession, TimelineAgentChatPanel } from '@percena/weft-node/chat'
import { createHostAgentRuntime } from '@percena/weft-node/runtime'

const { runtime } = createHostAgentRuntime({
  provider: 'codex',
  cwd: '/Users/me/project',
  candidates: [{ kind: 'app-server', available: true }],
  auth: { mode: 'provider-owned', configured: true, source: 'codex-app-server' },
})

// In a React component:
const session = useAgentSession({
  sessionId: runtime.sessionId,
  createRuntime: () => runtime,
})

return <TimelineAgentChatPanel runtime={session.runtime} />
```

> `createHostAgentRuntime` is synchronous — it returns `{ runtime, sourceRuntime? }` directly, no `await` needed.

---

## Integration Pattern 2: Headless (No React)

For server-side or non-React contexts, use `WeftClient` directly. It provides namespaced access to sessions, runs, and timeline over HTTP + SSE.

```ts
// WeftClient is exported from the providers/flitro subpath of @percena/weft.
import { WeftClient } from '@percena/weft/providers/flitro'

const client = new WeftClient({
  server: 'https://agents.example.com',
  token: scopedToken,
})

// Subscribe to the session's SSE timeline (async iterable)
const stream = client.timeline.subscribe(sessionId)
for await (const envelope of stream) {
  console.log(envelope.item.type, envelope.seq)
}

// Send a message
await client.runs.create(sessionId, { message: 'Summarize the latest changes' })

// Respond to a permission request
await client.sessions.respondToPermission(sessionId, requestId, true)
```

---

## Provider Authentication

Weft uses a **Provider-Owned** authentication strategy — it detects and delegates, never injects third-party credentials. Auth detection is part of `@percena/weft-node` (Node.js only, upcoming — see the note in Pattern 1):

```tsx
import { readClaudeAuth, readCodexAuth } from '@percena/weft-node/runtime'

// Read Claude auth (~/.claude) — async, returns ProviderAuthDetection
const claudeAuth = await readClaudeAuth()
// { mode: 'provider-owned', configured: true, source: 'claude auth status --json', ... }

// Read Codex auth (~/.codex) — async, spawns `codex app-server account/read`
const codexAuth = await readCodexAuth()
// { mode: 'provider-owned', configured: true, source: 'codex app-server account/read', ... }
```

Both functions are async and return a `ProviderAuthDetection` object (never `null` — check the `configured` field).

---

## Related Documentation

- [ARCHITECTURE.md](./ARCHITECTURE.md) — Architecture: design principles, runtime tiers, timeline contract, streaming pipeline
