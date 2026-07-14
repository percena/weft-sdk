# Weft

**Weaving agents into your app.**

Weft is an embeddable **agent chat runtime SDK**. Drop a streaming chat panel into your app, and the agent can drive your REST API through named tools, respect your state machine, and visually replay each call on the page with live cursor automation.

Ships as two packages:

- **`@percena/weft`** — browser. Production-ready. Powers the agentic-SaaS story below.
- **`@percena/weft-node`** — desktop/VPS in-process host. Published on npm — see [Desktop with `@percena/weft-node`](#desktop-with-percenaweft-node).

```
Your app  ──embed──▶  @percena/weft  ──▶  streaming agent chat panel
                                          (timeline · action-bridge · live cursor automation)
                                              │
                                              ▼  agent drives your REST API · replays each call on the UI
```

---

## Where Weft Shines

The browser package is production-ready today — here's where that pays off.

Weft is built for **vertical SaaS** — industry-specific service platforms whose
end user is a *professional operator* (not a developer) running **complex,
multi-step, policy-governed workflows** across many interrelated resources. In
these products the value is rarely a single clever API call; it's *orchestrating
a chain of stateful, role-gated operations* — exactly the work an agent can take
off the operator's hands.

Rather than rebuilding the backend, Weft layers an agent on top of the SaaS's
**own existing REST / OpenAPI surface**. It turns "click through eight screens to
resolve a P1 incident" into "tell the agent what you want." The agent drives the
named tools, respects the domain **state machine** (illegal transitions bounce
back as a `409` backstop), honors **role separation**, and **visually replays**
each action on the UI with live cursor automation. The end-user experience jumps from
*expert-only console* to *conversational self-service* — without the SaaS vendor
rewriting their product.

**Concrete scenarios where this agentic-SaaS transformation pays off:**

| Domain | The professional workflow an agent can drive |
|--------|----------------------------------------------|
| **IT service management** | P1 incident response — create + link affected CIs, assign, escalate, resolve, close; CAB change approvals + rollback; CMDB dependency traversal *(our `apps/itsm` demo)* |
| **E-commerce / order ops** | Order lifecycle — checkout, pay, ship, deliver, refund request / approve / deny; cart + inventory *(our `apps/online-store` demo)* |
| **Healthcare / clinical ops** | Lab order → result → diagnosis chain; insurance prior-authorization; care-plan adherence; multi-party handoffs |
| **Banking / financial ops** | Loan origination, KYC/AML review, trade settlement, account opening — compliance-heavy, multi-approver chains |
| **Logistics / supply chain** | Shipment booking, customs clearance, warehouse transfers, dispatch + exception handling |
| **HR / people ops** | Onboarding / offboarding across systems, payroll changes, leave approval, benefits enrollment |
| **Legal practice mgmt** | Matter lifecycle, document assembly, court-deadline calendaring, billing |

The common thread: a stateful domain model, a state machine that gates
transitions, role separation, and an API surface that already encodes the
business rules. Weft's job is to let an agent operate that surface *correctly*
and *visibly* — delivering an agentic experience the end user can trust. The next
section shows exactly how that transformation works.

---

## How it works

*Classic REST SaaS → agentic, without rewriting the backend.*

```
Your REST SaaS (unchanged)
  · OpenAPI spec       →  named tools:  <toolset>_<operationId>
  · state machine      →  system prompt (rendered from the SM — single source of truth)
  · REST + SPA
        │
        │  tools execute same-origin in the browser (cookie-authed,
        │  X-Weft-Actor stamped) — the agent never needs a separate API token
        ▼
  Agent runtime  —  drives your REST tools, streams the canonical timeline
        │
        ▼   chat stream (SSE)  +  live cursor automation
  @percena/weft  —  TimelineAgentChatPanel · ActionReplayLayer
        │
        ▼   illegal transition → 409 { error, allowed_actions }
            agent relays the legal options + recovers — no blind retry
```

- **Your REST SaaS stays unchanged.** Same-origin SPA + API, existing OpenAPI spec, existing state machine — nothing is rewritten.
- **Tools come from your OpenAPI.** Each operation becomes a named tool `<toolset>_<operationId>`, executed same-origin in the browser with the user's cookie (`execution: client`) — the agent never needs a separate token for your API.
- **The system prompt is rendered from your state machine** — the same transitions the API enforces — so the prompt can't drift from the rules.
- **The state machine is the reactive backstop.** An illegal transition returns `409 { error, allowed_actions }`; the agent relays the legal options and recovers — no blind retry.
- **A fail-open dependency graph** (`required: false` by default) routes multi-step calls but never blocks — a wrong graph degrades routing hints, not correctness.
- **The action-bridge replays each tool call on the UI** with live cursor automation, so the operator sees exactly what the agent did.
- **`@percena/weft`** ships the chat panel, the timeline, and the action-bridge; the `integrate-weft-kit` skill builds this whole layer from your OpenAPI spec, closed-loop (build → headed test → self-repair). The two demos below are its reference outputs.

---

## Quick start

The shipped SDK is the browser package — it is what the demos and the skill use.

```bash
npm install @percena/weft
```

Mount the chat panel and plug in an embed runtime that connects it to your agent backend:

```tsx
import { TimelineAgentChatPanel, useAgentSession } from '@percena/weft/chat'
import '@percena/weft/styles'

const session = useAgentSession({
  sessionId,
  createRuntime,   // embed runtime → your agent backend
})                  // → see apps/online-store/agentic/src/App.tsx for the wiring

return <TimelineAgentChatPanel runtime={session.runtime} />
```

| Import Path | Description |
|-------------|-------------|
| `@percena/weft` | Core types + canonical timeline + runtime-core + hosted-mode React hooks |
| `@percena/weft/chat` | `TimelineAgentChatPanel`, `useAgentSession`, reconnect/catchup |
| `@percena/weft/action-bridge` | `ActionReplayLayer`, `weftAction` (live cursor automation) |
| `@percena/weft/styles` | CSS theme (custom properties) |
| `@percena/weft/providers/flitro` | Browser embed runtime — connects the chat panel to the hosted Weft control plane (`weftd`); the only runtime the demos ship today |

> Building a desktop or VPS app? `@percena/weft-node` runs the agent in-process — see [Desktop with `@percena/weft-node`](#desktop-with-percenaweft-node) below.

> **Control-plane dependency.** The browser SDK ships the chat panel, the timeline, and the action-bridge. Its embed runtime (`@percena/weft/providers/flitro`) connects the panel to the **Weft control plane** (`weftd`) — a hosted service operated by Percena that provisions the agent app, mints scoped session tokens, and brokers the LLM run/timeline stream. The control plane (`weftd` / the agent runtime) runs as cloud hosted service; this repository ships the SDK, the two demos, and the `integrate-weft-kit` skill. To run the demos or any embed-runtime integration you register a tenant at the [Weft console](https://weft-kit.dev) — see each demo's `README.md` + `.env.example` for the credentials it expects. The SDK itself (types, timeline, runtime contract, UI, action-bridge) is MIT-licensed and usable independent of the hosted plane.

---

## Skills — the classic → agentic conversion

The SDK gives you the chat panel and the timeline runtime. **The skill is what turns a traditional REST app into an agentic one.** `integrate-weft-kit` is the agent skill that does it: given an existing REST API with an OpenAPI spec, it layers a Weft chat panel on top whose LLM agent drives your REST API through named tools derived from that spec — with live cursor automation that visually replays each call on the page. This is the engine of the vertical-SaaS transformation above: **no rip-and-replace, no backend rewrite** — the agent operates the very endpoints the page already uses, and the state machine stays the reactive backstop.

> Proven end-to-end on two demos — `apps/online-store/agentic/` (Node) and `apps/itsm/agentic/` (Python/FastAPI) — both built by this skill from their `classic/` counterparts. See [Demos](#demos).

### Install

Install the skill into your project — the CLI auto-detects your agent (Claude Code, Codex, Cursor, …) and installs into the right location:

```sh
npx skills add percena/weft-sdk                               # all skills in the repo
npx skills add percena/weft-sdk --skill integrate-weft-kit    # just this skill
npx skills add percena/weft-sdk -a codex                      # target a specific agent (e.g. Codex)
npx skills add -g percena/weft-sdk                            # user-level (~/.claude/skills/, ~/.codex/skills/, …)
```

The skill is a multi-file package: `SKILL.md` (the runbook) plus `templates/` (the parameterized agentic layer — Node `.mjs` and Python) and `references/` (fail-open / `plan_route` / execution-model theory). Source lives in this repo under [`skills/`](skills/).

### How it works

Once installed, the skill activates when you ask your agent to make a REST API agentic, or to model/repair its state machine or API dependency graph. It runs as a **closed loop** — build → headed test → self-repair — not a one-shot recipe (a per-language template set could never cover every backend):

1. **Inventory** the classic app — resources, state machines (incl. `$prior` back-edges), auth roles, UI pages/tabs, SSE events. This inventory drives the test coverage.
2. **Build** the agentic layer against a 9-point integration contract: same-origin SPA + API; `POST /api/chat/session` + scoped token mint; reverse-proxy to the agent runtime (unbuffered SSE); `X-Weft-Actor` → event-actor; agent-runtime provisioning (app + toolset + skill + automation + graph); the OpenAPI as the tool source (`tool_name = <toolset>_<operationId>`); the system prompt rendered from the shared state machine; a fail-open dependency graph; and the frontend chat + action-bridge layer. Fast-path templates exist for **Node** and **Python**; for any other backend the LLM implements the contract in your idiom.
3. **Test** every feature in a **headed** Playwright e2e, the test list generated from the inventory × the test categories (wiring, feature regression, agent driving, visual feedback, cross-cutting, security). Verify via ground-truth state — not chat text.
4. **Self-repair** — on failure, reproduce → isolate root cause → fix → re-run until green. Durable findings can feed back into a forked skill (new fast-path, common mistake, or contract clarification).

The state machine is the reactive backstop (`409 { error, allowed_actions }` → relay + recover, no blind-retry) and the dependency graph is fail-open (`required: false`) — see [How it works](#how-it-works) for the conceptual model.

### Learn more

- [`skills/README.md`](skills/README.md) — install commands
- [`skills/integrate-weft-kit/SKILL.md`](skills/integrate-weft-kit/SKILL.md) — the full runbook (contract, test categories, common mistakes, Phase 3 e2e + self-repair)
- The two skill-built demos — `apps/online-store/agentic/` (Node) + `apps/itsm/agentic/` (Python) — are the canonical references; clone the repo and read them alongside the skill.

---

## Demos

Two reference apps prove the pattern end-to-end. Each ships as a pair: `classic/`
(a hand-written traditional SaaS, no AI — the input) and `agentic/` (the same app
+ a Weft chat agent that drives it — built from `classic/` by the
`integrate-weft-kit` skill). Together they cover **two backends** (Node + Python)
and **two domains** (an approachable one + a high-stakes one).

| Demo | Domain | Backend | What the agent drives |
|------|--------|---------|-----------------------|
| [`apps/online-store`](apps/online-store/) | E-commerce | Node (REST + SPA) | `shop_*` tools — browse, cart, checkout, pay, ship, refund (8-state order SM). The skill's **1st** demo + reference output. |
| [`apps/itsm`](apps/itsm/) | IT service mgmt | Python / FastAPI + React | `itsm_*` tools — P1 incident response, CAB change + rollback, CMDB traversal (Incident 6-state + Change 9-state SM, 3-role auth). The skill's **2nd** demo: a non-JS backend + a harder domain. |

In either demo: log in, set the chat permission to **Auto**, and describe the
task in plain language — the agent drives the SaaS's REST API through named
tools, the **action-bridge** replays each call on the UI with live cursor automation, and the
result lands in `/api/state`. The frontend uses `@percena/weft` (chat panel +
action-bridge); the backend adds a chat-session endpoint and proxies chat
traffic to the agent runtime — and imports no Weft library. Build/run details
live in each app's `README.md`.

### Recorded walkthroughs

Each demo recorded end-to-end — the agent driving the SaaS's REST API with live
cursor automation. (GitHub's markdown sanitizer strips raw `<video>` tags from
README HTML, so each link below opens the recording in GitHub's built-in player
on the file's blob page.)

| Demo | Recording |
|------|-----------|
| `apps/online-store` — Node e-commerce | [🎬 `online-store-agentic.mp4`](apps/online-store/online-store-agentic.mp4) |
| `apps/itsm` — Python/FastAPI ITSM | [🎬 `itsm-agentic.mp4`](apps/itsm/itsm-agentic.mp4) |

---

## Desktop with `@percena/weft-node`

For desktop and VPS apps — Electron, Tauri, or a local daemon — `@percena/weft-node` runs the agent in-process: the same chat panel and timeline, but driving Claude (Agent SDK + `claude -p` fallback) or Codex (app-server + `codex exec` fallback) natively, with provider-owned auth and the full extension plane (policy, sources, skills, automations).

```bash
npm install @percena/weft-node react react-dom
```

`react` / `react-dom` are peer dependencies (React 18.2+ or 19). Add `@anthropic-ai/claude-agent-sdk` only when using the native Claude runtime (`@percena/weft-node/providers/claude/sdk`); Codex-only hosts and the `claude -p` CLI fallback do not require it.

Mount the panel and plug in a local runtime that drives Claude or Codex directly:

```tsx
import { TimelineAgentChatPanel, useAgentSession } from '@percena/weft-node/chat'
import { createHostAgentRuntime } from '@percena/weft-node/runtime'
import '@percena/weft-node/styles'

const { runtime } = createHostAgentRuntime({
  provider: 'codex',                 // or 'claude'
  cwd: '/path/to/your/project',
  candidates: [{ kind: 'app-server', available: true }],
  auth: { mode: 'provider-owned', configured: true, source: 'codex-app-server' },
})

const session = useAgentSession({ sessionId: runtime.sessionId, createRuntime: () => runtime })
return <TimelineAgentChatPanel runtime={session.runtime} />
```

`@percena/weft-node` exposes the same subpaths as `@percena/weft` (`.`, `./chat`, `./styles`) plus the Node-only surfaces (`./runtime`, `./providers/claude`, `./providers/codex`, `./skills`, `./sources`, `./automations`, `./policy`, `./cli-runtime`). It is **not** browser-safe — it imports `node:child_process` and other Node built-ins; for browser/web apps use [`@percena/weft`](#quick-start) instead. For the runtime contract, provider selection, and auth detection, see [Architecture](docs/ARCHITECTURE.md) + [Getting started — Desktop / Node.js](docs/GETTING-STARTED.md#desktop--nodejs-claude--codex).

---

## Architecture

Weft is a layered SDK: a zero-dependency type core, a canonical timeline, a runtime contract with provider adapters, an extension plane (policy / sources / skills / automations), and an embeddable chat UI. Provider event streams flow in, get sequenced into `TimelineEnvelope`s, and render through a pure reducer into the chat panel.

```
Host App  (Electron / Tauri / VPS daemon / Browser)
  │
  ▼
@weft/runtime-core ─── AgentRuntime contract · state machine · command sink
  │
  ▼
@weft/providers ────── Claude (native SDK + CLI fallback) · Codex (app-server + CLI) · browser embed runtime · factory
  │
  ▼
@weft/policy · @weft/sources · @weft/skills · @weft/automations   (extension plane)
  │
  ▼
@weft/timeline ─────── canonical event schema · seq / cursor / replay / merge
  │
  ▼
@weft/ui → @weft/chat ─ TurnCard · StreamingMarkdown · PermissionRequestCard · AgentChatPanel
```

The full design — runtime tiers, provider selection, the timeline contract, the runtime state machine, package responsibilities, the streaming pipeline, and the extension plane — lives in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

---

## Getting started (development)

### Prerequisites

- **Node.js** ≥ 22 (see `.nvmrc`)
- **pnpm** ≥ 10
- **TypeScript** ≥ 6.0

### Install

```bash
git clone https://github.com/percena/weft-sdk && cd weft-sdk
pnpm install
```

### Verify

```bash
pnpm run test      # all tests
pnpm run check     # type-check the monorepo
pnpm run build     # build all packages (topological L0→L4)
```

Real-provider integration tests are opt-in (they depend on personal auth):

```bash
WEFT_RUN_REAL_AGENT_E2E=1      npx vitest run packages/e2e-tests/src/real-provider-smoke.test.ts   # app-server auth probe
WEFT_RUN_REAL_CODEX_TURN_E2E=1 npx vitest run packages/e2e-tests/src/real-provider-smoke.test.ts   # real Codex turn
WEFT_RUN_REAL_CLAUDE_E2E=1     npx vitest run packages/e2e-tests/src/real-provider-smoke.test.ts   # real Claude turn
```

### Chat playground

```bash
pnpm run playground
```

Open the local URL and click **Start** to replay canonical timeline fixtures (mock data only — no backend). Add `?autoplay=1` for auto-play.

### Project layout

15 internal workspace packages under `packages/`, dual publish facades under `publish/` (`@percena/weft` browser + `@percena/weft-node` desktop), the demos under `apps/`, and the skill under `skills/`. Full tree in [`docs/GETTING-STARTED.md`](docs/GETTING-STARTED.md).

---

## Documentation

| Document | Description |
|----------|-------------|
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | Architecture: design principles, runtime tiers, timeline contract, streaming pipeline |
| [GETTING-STARTED.md](docs/GETTING-STARTED.md) | Setup, project structure, testing, and demo usage |
| [EMBEDDING.md](docs/EMBEDDING.md) | Embedding the chat panel: minimal embed, bootstrap sequence, CORS + a11y checklists |
| [SECURITY-MODEL.md](docs/SECURITY-MODEL.md) | Trust boundaries: the browser↔control-plane split, the scoped session token, header allowlists |

---

## Known limitations

- **The browser embed runtime depends on the hosted Weft control plane.** `@percena/weft/providers/flitro` (the only embed runtime shipped today) connects the chat panel to the `weftd` control plane — a hosted service you provision a tenant for at the [Weft console](https://weft-kit.dev). This repository ships the SDK, the demos, and the `integrate-weft-kit` skill. A self-hostable / offline mock runtime is on the roadmap; until then, running the demos or any embed-runtime integration requires a tenant.
- **ESM-only — no CJS build.** The package ships ESM only (`.js` + `.d.ts`, no `.cjs`/`.d.cts`); `require('@percena/weft')` throws `ERR_REQUIRE_ESM`. All documented usage and the `integrate-weft-kit` skill templates use ESM `import`, so bundler consumers (Vite/webpack 5/Next.js/Rollup) are unaffected. (A prior CJS facade existed but was broken: the code-splitting that deduplicates the `@weft/ui` graph across the `.`/`./chat`/`./providers/flitro` entries is ESM-only, so CJS facades each bundled the full `@weft/*` graph inline and a CommonJS consumer importing both `.` and `./chat` loaded two `@weft/ui` context-state instances. Dropping CJS removes that footgun.)

---

## Current Status

**All packages building** · Claude Agent SDK + Codex app-server verified · Hosted control plane operational · `@percena/weft` + `@percena/weft-node` published on npm

### What's Built

- ✅ SDK-first runtime with `native-sdk` / `app-server` / `cli-fallback` selection
- ✅ Canonical timeline with seq/epoch/cursor, reconnect, replay, gap detection
- ✅ Claude Agent SDK driver with permission bridge and MCP source mapping
- ✅ Codex app-server driver with JSON-RPC client and approval bridge
- ✅ Browser embed runtime provider (connects the chat panel to a remote agent backend)
- ✅ Provider-neutral permission policy with layered rules and scoped approvals
- ✅ Source/skill activation plans with credential boundary
- ✅ Automation runtime bridge with loop guard, history store, and scheduler
- ✅ Embeddable `AgentChatPanel` with reconnect/catchup and inline permissions
- ✅ Two agentic-SaaS reference demos — `apps/online-store` (Node) + `apps/itsm` (Python/FastAPI): classic REST → skill-built agentic, e2e verified
- ✅ Publishable agent skill `integrate-weft-kit` (`npx skills add percena/weft-sdk`) — turns a classic REST+OpenAPI app into an agentic one via a closed-loop contract
- ✅ Host services: audit, artifacts, notifications, utility tools, privileged execution
- ✅ `@percena/weft` (browser) + `@percena/weft-node` (desktop) published on npm
- ✅ Node.js runtime (Bun fully removed — `child_process`, `node:http`, `ws`)
- ✅ pnpm workspace + vitest test suite + tsup build pipeline

### What's Next

- 🔲 Tune `@percena/weft` SDK and the hosted control plane for accuracy and latency
- 🔲 Improve the `integrate-weft-kit` skill
- 🔲 Harden `@percena/weft-node` SDK for production

---

## License

[MIT](LICENSE) © Percena 2026
