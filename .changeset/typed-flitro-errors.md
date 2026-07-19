---
"@percena/weft": minor
"@percena/weft-node": patch
---

Export `WeftHttpError` from the browser Flitro provider entry with stable weftd error codes, prevent built-in OpenAI credentials from reaching custom Codex gateways in the Node runtime, preserve structured error fields on synthetic `turn_failed` timeline items, and reject immediately-drained deferred sends with the original typed error. Also export `readTurnFailedError` / `TurnFailedErrorInfo` from both root entries as the supported way to consume `turn_failed.error` (no more casting `unknown`).
