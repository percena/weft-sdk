# Embedding Weft

The minimal path to embed the chat panel into a React app, plus the
integrator-facing sequence for the session bootstrap + the CORS / accessibility
checklists. For the threat model see [SECURITY-MODEL.md](./SECURITY-MODEL.md);
for internals see [ARCHITECTURE.md](./ARCHITECTURE.md).

## Minimal embed (no weftd internals)

```tsx
import '@percena/weft/styles' // or '@percena/weft/styles/core' if you don't render math
import { TimelineAgentChatPanel, useAgentSession } from '@percena/weft/chat'
import { createFlitroEmbedRuntime } from '@percena/weft/providers/flitro'

function App() {
  const session = useAgentSession({
    // The browser only ever sees the scoped token; the backend mints it from
    // the developer credential (server-side). Token refresh is 401-triggered.
    getSession: async () => {
      const r = await fetch('/api/chat/session', { method: 'POST' })
      const { sessionId, token, baseUrl } = await r.json()
      return { sessionId, token, baseUrl }
    },
    onTokenExpired: async (sessionId) => {
      const r = await fetch(`/api/chat/session/${sessionId}/token`, { method: 'POST' })
      return (await r.json()).token
    },
    runtime: createFlitroEmbedRuntime(),
  })

  return <TimelineAgentChatPanel session={session} permissionMode="ask" />
}
```

Entry points (full table in the [package README](../publish/browser/README.md)):

| Subpath | Use |
| --- | --- |
| `@percena/weft` | Core runtime + `useAgentSession`, `TimelineAgentChatPanel`, `createFlitroEmbedRuntime` |
| `@percena/weft/chat` | Full streaming chat panel + hooks + i18n fallback |
| `@percena/weft/providers/flitro` | Browser-safe Flitro embed runtime (pure `fetch` + SSE) |
| `@percena/weft/action-bridge` | `weftAction(...)` annotations + `ActionReplayLayer` replay |
| `@percena/weft/styles` | Precompiled panel CSS incl. KaTeX |
| `@percena/weft/styles/core` | Math-free panel CSS — opt out of the ~296 KB KaTeX woff2 fonts |

React ≥ 18.2 is a peer dependency (19 supported; the SDK uses no React-19-only
APIs).

## Session bootstrap sequence

```
Browser                 Your backend              weftd
  |   POST /api/chat/session  |                       |
  | ------------------------> |                       |
  |                           | POST /v1/sessions     |
  |                           | ------------------->  |
  |                           | {session_id,token,...}|
  |                           | <-------------------  |
  |  {sessionId,token,baseUrl}|                       |
  | <------------------------ |                       |
  |                           |                       |
  |  POST /v1/sessions/{id}/runs  (Authorization: scoped token) |
  | ----. /v1/* reverse proxy .----> |  (Cookie STRIPPED)      |
  |     `------------------------->  | ----------------------> |
  |  SSE run/timeline stream <=======| <===================== |
```

The `/v1/*` proxy streams the SSE **unbuffered** and retries only
pre-handshake (TLS-drop) errors — never mid-stream (headers already sent →
would replay non-idempotent POSTs).

## CORS

Same-origin SPA + API needs no CORS in production. During dev the Vite server
(:5173) hits the backend (:19745), so the backend reflects the request `Origin`
against a `DEMO_CORS_ORIGIN` allowlist (comma-separated exact origins). Unset =
dev-only permissive reflection. **Never** use `Access-Control-Allow-Origin: *`
with cookie-authenticated sessions — it is inert for credentialed cross-origin
fetches and signals "wide open" to integrators copying the template.

```bash
# .env (production)
DEMO_CORS_ORIGIN=https://shop.example.com,https://www.example.com
```

## Accessibility checklist

The chat panel is the primary interactive surface; these are the contract the
embedding app + the SDK commit to. The Biome a11y rules that are **error** in
the chat-panel source today (`packages/ui`, `packages/chat`, `publish/*/src`):
`useButtonType`, `noSvgWithoutTitle`, `noAutofocus`, `noLabelWithoutControl`.
The three that remain **warn** (tracked debt — the interactive-`div` patterns
in the transcript) need a dedicated pass:

- [ ] **Keyboard reachability** — every agent action (approve plan, allow tool,
  copy, regenerate) is reachable + operable by keyboard alone. The transcript
  uses `div`-on-click in several places (`useKeyWithClickEvents`,
  `noStaticElementInteractions` warn); convert to `button`/`role="button"` +
  `tabIndex={0}` + a keydown handler, or document the role explicitly.
- [ ] **Live regions for streaming** — the streaming assistant turn must be
  announced to screen readers as it grows. Wrap the streaming content in
  `aria-live="polite"` (`assertive` only for error/recovery turns) so a SR user
  knows new content arrived without manual focus.
- [ ] **Focus trap in permission dialogs** — the "Allow tool?" /
  "Approve plan?" prompts are modal; trap focus within them while open,
  return focus to the composer on close. (`noAutofocus` is already error — do
  not steal focus on mount.)
- [ ] **Permission-mode control** — the Ask/Auto/Explore selector is a real
  form control (`useButtonType` error ensures the trigger is a `button` with a
  `type`); label it for SR users.
- [ ] **Code blocks** — Shiki output is decorative markup; the raw source is
  available — provide a "copy" affordance (already present) and ensure the
  `pre`/`code` semantics are preserved (do not nest interactive controls inside
  code blocks).
- [ ] **Visual-only feedback** — the automated live cursor (action-bridge) and
  the streaming shimmer are **supplemental**, not the only signal. Every state
  change they visualize must also be announced via a live region or an
  `aria-atomic` status node.
