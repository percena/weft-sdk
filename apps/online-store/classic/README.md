# Online Store (Classic)

A traditional REST store — cookie sessions, SSE event feed, order state machine,
SPA storefront. **No weftd, no AI.** This is the **scaffold source** for the
`integrate-weft-kit` skill: the agentic variant (`../agentic/`) is built by
adding the Weft chat layer on top of this.

## Run

```sh
pnpm install
pnpm start   # builds the web bundle + serves on http://127.0.0.1:19743
```

Open the URL, log in (any username), and use the storefront — products, cart
(qty management), orders with the status timeline. The order state machine:
`pending_payment → paid → shipped → delivered → completed`; `cancel` (from
pending/paid); refund `request → approve/deny` (deny restores the prior status).
Illegal transitions return `409 + allowed_actions`.

`pnpm test` = the state-machine + REST route tests.
