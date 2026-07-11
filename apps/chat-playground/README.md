# Chat Playground

A Weft chat UI playground: replay full agent conversations (tool calls, permission approvals, streaming output) from mock data, or connect to a real runtime (Claude / Codex) for live sessions.

## Quick Start

```bash
cd apps/chat-playground

# No .env needed — just start
pnpm dev
#    → http://127.0.0.1:5173
```

The app opens in **Fixture mode** by default: click Start to replay a pre-built timeline (a complete "update config file" agent conversation).

- Add `?autoplay=1` to the URL for auto-play
- Switch to the **Live** tab to connect to a real runtime

## Two Modes

### Fixture Mode (default, no backend)

Uses pre-built timeline events from `demo-session.ts` to demonstrate:
- User message → agent reasoning → tool calls (Read/Write) → permission approval → streaming reply → turn complete
- Timeline detail panel (runtime capability report, source state, permission status)
- TurnCard component rendering (activity collapse/expand, tool output)

### Live Mode (requires runtime host)

Connect to a real runtime server for live conversations:

```bash
# 1. Configure runtime URL (optional, defaults to 127.0.0.1:4127)
cp .env.example .env
#    Edit VITE_RUNTIME_URL to point to your runtime

# 2. Start the playground
pnpm dev
```

Switch to the Live tab in the UI, select a provider (Claude / Codex), enter a working directory, and connect. Supports:
- Real-time SSE streaming output
- Tool call visualization (command execution, file search)
- Session persistence (localStorage)
- Multi-session management

## .env Configuration

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `VITE_RUNTIME_URL` | No | `http://127.0.0.1:4127` | Runtime host URL for live sessions |

> Fixture mode needs no `.env` — it works out of the box.

## Tech Stack

- React 19 + Vite 6 + Tailwind CSS v4
- `@weft/ui` — TurnCard, UserMessageBubble, processEvent, and other UI components
- `@weft/core` — PermissionMode and other type definitions
- `@weft/timeline` — TimelineEnvelope type
- Does not depend on the `@percena/weft` published package — uses internal workspace packages directly

## Layout

| Path | Description |
| --- | --- |
| `src/App.tsx` | Main UI: Fixture / Live mode switching, timeline rendering, session management |
| `src/demo-session.ts` | Mock timeline data for Fixture mode |
| `src/runtime-client.ts` | Runtime HTTP/WebSocket client for Live mode |
| `src/live-session-store.ts` | Live session persistence (localStorage) |
| `src/timeline-transcript.ts` | Timeline → chat transcript conversion |
| `src/i18n-init.ts` | i18next initialization (en fallback from `@weft/ui`) |
