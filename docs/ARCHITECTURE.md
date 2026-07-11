# Weft — Architecture

Weft is an SDK-first, provider-agnostic AI Agent Chat Runtime. It takes heterogeneous event streams from multiple AI agent providers and weaves them into a single canonical timeline, powering an embeddable, production-grade streaming Chat UI.

---

## Design Principles

1. **SDK-First** — Provider-native SDKs and app-servers are the default runtime path; CLI streaming is an explicit fallback, never silent.
2. **Provider-Owned Auth** — Weft detects and delegates provider authentication. It never stores, injects, or transfers credentials across providers.
3. **Canonical Timeline** — Every provider event maps to a unified `TimelineEnvelope` carrying `seq`, `epoch`, `timestamp`, and the `item` payload; the timeline sequencer layers `cursor` and `gap` semantics for live streaming, reconnect, replay, and catch-up.
4. **Streaming-First UI** — Polished TurnCard with buffered rendering, throttled updates, block-level memoization, and tool activity details.
5. **Extension Plane** — Policy, Sources, Skills, and Automations plug in through runtime hooks and timeline events — never inside provider adapters.
6. **Node.js Core** — All runtime packages use standard Node.js APIs (`child_process`, `node:http`, `ws`). No platform-specific runtime dependencies.
7. **Zero Deep Imports** — All cross-package imports use proper package-level entries.

---

## Runtime Three-Tier Classification

Weft supports three tiers of provider runtime, in decreasing priority:

### Tier 1: Provider Primary Runtime (default)

The default and preferred runtime for each provider, realized as `native-sdk` (Claude Agent SDK) or `app-server` (Codex app-server, Flitro HTTP/SSE).

- Create/resume sessions
- Stream assistant/reasoning/tool/usage events
- Handle interrupts, continuations, and permission responses
- Read provider-owned auth/config without storing or injecting cross-provider tokens
- Map provider raw events to the Weft canonical timeline

### Tier 2: Provider-Compatible SDK Runtime (extension)

Extensibility path for third-party or bridged providers.

- Must implement the same `AgentRuntime` contract
- May only depend on `@weft/runtime-core`; no reverse dependency on UI
- Provider-specific events must be mapped to the canonical timeline before reaching the UI
- Does not participate in provider selection unless the user or host app explicitly opts in

### Tier 3: Local CLI Fallback Runtime (safety net)

Fallback path used when SDK or app-server runtimes are unavailable.

- Multi-turn resume capability is limited
- Permission response may not form a complete closed loop
- Must never silently degrade from SDK to CLI; produces a `runtime_fallback` timeline event
- Fallback is clearly visible in `RuntimeCapabilityReport`

---

## Canonical Timeline Contract

### TimelineEnvelope

Every timeline event is wrapped in an envelope: `sessionId`, `provider`, `seq` (per-session monotonic index), `epoch` (invalidated on reset/compaction), `timestamp`, the `item` payload, and an optional `rawRef` pointing back to the originating provider event for full-detail display. The timeline sequencer layers `cursor` and `gap` semantics on top for reconnect and catch-up.

This supports live streaming, reconnect with gap detection, full detail display, unified status across providers, and future persistence and replay.

### TimelineItem Types (26)

| Category | Types |
|----------|-------|
| **Messaging** (5) | `user_message`, `assistant_message_delta`, `assistant_message`, `reasoning_delta`, `reasoning` |
| **Tool lifecycle** (5) | `tool_call`, `tool_output_delta`, `tool_result`, `tool_suspended`, `tool_resumed` |
| **Permission lifecycle** (3) | `permission_requested`, `permission_resolved`, `permission_policy_changed` |
| **Extension state** (3) | `source_state_changed`, `skill_activated`, `host_state_changed` |
| **Automation** (2) | `automation_triggered`, `automation_action_result` |
| **Runtime** (2) | `runtime_capability_report`, `runtime_fallback` |
| **Turn lifecycle** (3) | `turn_started`, `turn_completed`, `turn_failed` |
| **Session** (1) | `session_status` |
| **Compaction** (2) | `compaction_started`, `compaction_boundary` |

---

## Runtime State Machine

```
idle → preflighting → ready → starting → running
                                        → waiting_for_permission → running
                                        → turn_completed → ready
  any → failed / disposed
  any non-disposed → ready (via abort)
```

Key states:
- `preflighting` — detecting SDK/CLI/app-server capability and provider-owned auth
- `running` — processing a turn
- `waiting_for_permission` — paused, awaiting host call to `commands.respondToPermission()`
- `turn_completed` — current turn finished, session can continue
- `failed` — runtime cannot continue or needs explicit recovery

---

## Public Runtime Contract

`AgentRuntime` exposes:

- **Read surface** — `sessionId`, `provider`, `runtimeKind`, an `events` timeline stream, and a `commands` sink.
- **Methods** — `preflight()`, `fetchTimeline()` (cursor-based catch-up), `getState()`.

`runtimeKind` is one of `native-sdk` | `app-server` | `compatible-sdk` | `cli-fallback`.

The `commands` sink provides the write side: `sendMessage`, `abort`, `respondToPermission`, optional `resumeTool`, and `dispose`.

`preflight()` returns SDK/app-server/CLI availability, auth configuration status, the actual `runtimeKind` selected, and whether fallback occurred and why.

---

## Auth and Config Boundary

Weft respects provider-owned auth:
- Does not store provider tokens
- Does not automatically execute login flows
- Does not inject tokens from one provider into another
- Auth availability is a capability, not a UI assumption

**Provider auth** is detected by the provider package using officially supported methods. Provider config directories (`.claude/`, `CODEX_HOME`) are read by the provider package.

**Source auth** (Google, Slack, GitHub, Linear) is managed separately by `SourceCredentialManager` (in `@weft/sources`). Source credentials never enter provider auth.

---

## Extension Plane

Policy, Sources, Skills, and Automations are decoupled from provider runtimes. All extensions plug in through a `RuntimeExtensionContext` passed to `createHostAgentRuntime`, alongside the provider, working directory, runtime candidates, and auth descriptor. The extension context carries five slots:

- **`policy`** — permission mode and optional hook
- **`sources`** — enabled source slugs
- **`skills`** — active skill slugs
- **`commandOrigin`** — the origin a command is attributed to (`user`, `automation`, `host`, `scheduler`, `replay`, or `system`)
- **`hostServices`** — host tool bridge and privileged host services (audit, artifacts, notifications, tool-output governance)

### Permission Policy

`@weft/policy` evaluates a tool invocation against layered rules and scoped approvals, producing a three-way `ToolPolicyDecision`: `allow`, `ask` (with reason), or `deny` (with reason). Modes range from `safe` to `ask` to `allow-all`. The engine inspects the tool name, input, and a derived `toolIntent` (e.g. a bash command's base command) — never raw credentials.

### Source Activation

Sources register MCP (stdio/HTTP), API, or local tools into the runtime via `createSource` in `@weft/sources`. Source credentials are managed by `SourceCredentialManager` and never leak into provider auth (see [Auth and Config Boundary](#auth-and-config-boundary)).

---

## Package Responsibilities

### Core Runtime

| Package | Description |
|---------|-------------|
| `@weft/core` | Core types, utilities, and protocol DTOs: `AgentEvent`, `Message`, `Session`, errors, mentions parsing |
| `@weft/timeline` | Canonical timeline: `TimelineEnvelope`, seq/epoch/cursor, replay, merge, gap detection |
| `@weft/runtime-core` | `AgentRuntime` contract, capability report, state machine, extension context |

### Providers (unified package with subpath exports)

| Package | Description |
|---------|-------------|
| `@weft/providers` | Multi-entry provider package with shared scaffold |
| `@weft/providers/claude` | Claude Agent SDK driver + `claude -p` fallback + permission/source bridge |
| `@weft/providers/codex` | Codex app-server driver + JSON-RPC client + `codex exec` fallback |
| `@weft/providers/flitro` | Flitro HTTP+SSE provider (browser-safe), `WeftClient`, `createFlitroEmbedRuntime` |
| `@weft/providers/factory` | Desktop host runtime selector (`createHostAgentRuntime`) |
| `@weft/providers/shared` | `PushTimelineStream`, `createProviderRuntimeScaffold`, capability helpers |
| `@weft/adapter` | Claude/Codex backend abstraction: auth detection, event adapters, tool matching, error parsing |

### Extension Plane

| Package | Description |
|---------|-------------|
| `@weft/policy` | Permission modes (`safe`/`ask`/`allow-all`), tool policy engine, layered rules, approvals |
| `@weft/sources` | MCP / API / local source registry, `SourceCredentialManager`, credential boundary |
| `@weft/skills` | Skill definitions, storage, activation plan, required sources |
| `@weft/automations` | Event bus, cron/condition matcher, prompt/webhook actions, loop guard |

### UI & Chat

| Package | Description |
|---------|-------------|
| `@weft/ui` | React components + event processor: `TurnCard`, `SessionViewer`, `StreamingMarkdown`, `PermissionRequestCard`, `processEvent`, `useEventProcessor`, EventSource implementations |
| `@weft/chat` | Embeddable chat panel: `AgentChatPanel`, `TimelineAgentChatPanel`, `useAgentChatSession`, `useTimelineAgentChatSession`, `useAgentSession` |

### Host Infrastructure

| Package | Description |
|---------|-------------|
| `@weft/host-services` | Host-only contracts: privileged execution, audit, artifacts, notifications, tool output governance |
| `@weft/cli-runtime` | CLI fallback baseline: provider-owned Claude/Codex streaming session contract |
| `@weft/api-graph` | API dependency-graph analyzer: fail-open data-flow DAG for LLM tool-call sequencing (`plan_route` + veto); build-time, used by the skill + demos. Internal workspace-only — **folded into `@percena/weft`** (subpath `@percena/weft/api-graph` + `weft-api-graph` bin); never published as a separate npm package |

### Publish Facades

| Package | Target | Description |
|---------|--------|-------------|
| `@percena/weft` | Browser | Chat UI, hosted runtime, Flitro embed client, action-bridge, styles |
| `@percena/weft-node` | Node.js/Desktop | All browser entries + Claude/Codex providers, runtime factory, skills, sources, automations, policy |

---

## Streaming Pipeline

```
Provider SDK/CLI/App-Server
  │
  ▼
Provider Event Adapter (map to canonical timeline)
  │
  ▼
Timeline Sequencer (assign seq, epoch, cursor)
  │
  ▼
PushTimelineStream (emit TimelineEnvelope)
  │
  ├─▶ SSE transport (Flitro provider, browser-safe)
  ├─▶ WebSocket transport (desktop/VPS local host)
  │
  ▼
mapTimelineEnvelopeToProcessorEvent()
  │
  ▼
processEvent(state, event) → SessionState / Message[]
  │
  ▼
groupMessagesByTurn() → Turn[]
  │
  ▼
React Chat Panel (@weft/ui → @weft/chat)
  │
  ▼
TurnCard / StreamingMarkdown / PermissionRequestCard
```

Two transport paths from `PushTimelineStream` to the browser:
- **SSE** — Flitro provider (`WeftFetchSseTimelineStream`)
- **WebSocket** — Desktop/VPS local host server (`/sessions/:sessionId/stream`)

Both paths support cursor-based catch-up via HTTP `fetchTimeline`.

---

## Chat Panel Design

Three layers:

1. **`@weft/ui`** (pure display + processor) — `TurnCard`, `SessionViewer`, `StreamingMarkdown`, `PermissionRequestCard`, `processEvent`, `mapTimelineEnvelopeToProcessorEvent`, `groupMessagesByTurn`, EventSource implementations
2. **`@weft/chat`** (embeddable) — `TimelineAgentChatPanel` / `useTimelineAgentChatSession()`, `AgentChatPanel` / `useAgentChatSession()`, `useAgentSession()`, reconnect/catchup, inline permissions
3. **Host app** — Creates runtime, manages transport, file open, diff preview, notifications

### Integration Pattern

**Timeline-based (recommended):**

```tsx
import { useAgentSession, TimelineAgentChatPanel } from '@percena/weft/chat'
import { createFlitroEmbedRuntime } from '@percena/weft/providers/flitro'

const session = useAgentSession({
  sessionId,
  createRuntime: () => createFlitroEmbedRuntime({ baseUrl, token, sessionId }),
})

return <TimelineAgentChatPanel runtime={session.runtime} />
```
