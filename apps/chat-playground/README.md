# Chat Playground

A desktop (Electron) demo of the Weft local Coding Agent SDK: replay full agent
conversations from mock data (Fixture mode), or drive a real local
**Claude Code** / **Codex** agent turn end-to-end with zero server (Local mode).

The playground is the reference consumer of the `@percena/weft-node` package —
its Electron main process runs the local agent runtime in-process, and the
renderer reuses the shared React chat UI (`TurnCard`, processor, timeline).

## Quick Start

The playground imports the built `@percena/weft-node` dist, so build it once from
the repo root before the first run:

```bash
# from repo root — builds publish/desktop (the @percena/weft-node dist)
pnpm --filter @percena/weft-node build

cd apps/chat-playground

# No .env needed — launch the Electron window
pnpm dev
```

The app opens in **Fixture mode** by default: click Start to replay a pre-built
timeline (a complete "update config file" agent conversation). Switch to the
**Local** tab to run a real agent turn on this machine.

## Two Modes

### Fixture Mode (default, no backend)

Uses pre-built timeline events from `demo-session.ts` to demonstrate:
- User message → agent reasoning → tool calls (Read/Write) → permission approval → streaming reply → turn complete
- Timeline detail panel (runtime capability report, source state, permission status)
- TurnCard component rendering (activity collapse/expand, tool output)

A no-backend fallback that works out of the box — useful for UI/processor
development without local provider auth.

### Local Mode (real agent, no server)

Drives a real local agent through `@percena/weft-node/runtime` in the Electron
main process. The renderer streams `TimelineEnvelope` events over IPC and renders
them through the same processor + TurnCard UI as Fixture mode.

Requirements (local provider auth on this machine):
- **Claude**: the `claude` CLI logged in, or `@anthropic-ai/claude-agent-sdk`
  installed (native SDK path; falls back to the CLI otherwise).
- **Codex**: the `codex` CLI on `PATH` and logged in (`codex app-server`).

Select a provider (Claude / Codex), pick a working folder, set a permission mode
(Explore / Ask / Auto) and reasoning effort, then send a message. A real agent
turn streams into the timeline; permission requests surface an inline
Allow / Deny card whose decision round-trips back to the runtime.

## Tech Stack

- Electron 43 + electron-vite (main / preload / renderer) + React 19 + Tailwind v4
- `@percena/weft-node` — `createHostAgentRuntime` + `detectRuntimeCandidates`
  (in the main process), `TurnCard`, `processEvent`, `PermissionMode`,
  `TimelineEnvelope`, `EN_FALLBACK`, and the precompiled chat-panel CSS (renderer).
- The chat panel's CSS ships precompiled via
  `import '@percena/weft-node/styles'`; the playground's own Tailwind only styles
  its own UI.

## Layout

| Path | Description |
| --- | --- |
| `electron/main.ts` | Electron main: BrowserWindow + IPC driving `createHostAgentRuntime` |
| `electron/preload.ts` | `contextBridge` IPC surface (`window.weftDesktop`) |
| `shared/ipc-contract.ts` | IPC channel names + payload types (main/preload/renderer) |
| `electron.vite.config.ts` | main / preload / renderer build config |
| `src/App.tsx` | Main UI: Fixture / Local mode, timeline, permission cards, session management |
| `src/runtime-client.ts` | IPC-backed runtime client (envelope → processor state) |
| `src/demo-session.ts` | Mock timeline data for Fixture mode |
| `src/live-session-store.ts` | Local session persistence (localStorage) |
| `src/timeline-transcript.ts` | Timeline → chat transcript conversion |
| `src/i18n-init.ts` | i18next initialization (en fallback from `@percena/weft-node`) |

## Scripts

| Script | Description |
| --- | --- |
| `pnpm dev` | Launch the Electron app (HMR renderer + main) |
| `pnpm build` | Build main + preload + renderer to `out/` |
| `pnpm typecheck` | `tsc --noEmit` over `src` + `shared` + `electron` |
