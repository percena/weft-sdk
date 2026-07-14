# @percena/weft-node

## 0.1.1

The desktop / Node.js facade — the browser package plus in-process Claude
(Agent SDK + `claude -p` fallback) and Codex (app-server + `codex exec`
fallback) providers, skills, sources, automations, and policy.

> **Published on npm** — `0.1.1` stable on the `latest` tag, `0.1.0-next.0`
> on `next`.

### Minor

- Removed the dead `CodexEventAdapter` / `BaseEventAdapter` event pipeline
  from the codex provider surface. These converted OpenAI Responses-API SSE
  events into the legacy `AgentEvent` shape, but had zero live callers — the
  active codex app-server driver emits canonical `TimelineItem`s directly via
  `sequencer.append`. Consumers importing `CodexEventAdapter`,
  `CodexStreamEvent`, `CodexResponseItem`, or `CodexAdapterCallbacks` from
  `@percena/weft-node/providers/codex` (or `BaseEventAdapter` from
  `@weft/adapter`) must migrate to the `TimelineItem` stream — no behavior
  change for any runtime that was actually wired up.

### Patch

- Timeline replay reliability: session-SSE catchup sends the last-seen
  `epoch` so a server restart backfills the gap; a mid-replay `turn_failed`
  no longer wedges the runtime at `failed` (the terminal marker wins, via an
  additive `replay_reconcile` action). `sortTimeline` / `hasGap` are
  epoch-sound; overlapping catchup batches no longer double-append delta text.
- ESM facade bundles code-split — `@weft/ui` ships in a shared chunk instead
  of duplicated into each entry, fixing the two-context-state-instance bug
  where providers from `.` were invisible to components from `./chat`.
- HTML-spec-compliant SSE parser (CRLF framing, multi-`data:` lines, `id:`
  capture). Ring-buffer cap on the in-memory timeline + dedup set (default
  1000). `PushTimelineStream.connect` returns a per-listener unsubscribe. The
  reducer no longer silently resurrects a `failed` runtime on `send_message`;
  `isRunning` is reactive (mirrored state, not a non-reactive `getState()`
  read during render).
