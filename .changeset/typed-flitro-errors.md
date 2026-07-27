---
"@percena/weft-node": patch
---

(Browser `@percena/weft@1.0.2` already shipped the Flitro/WeftHttpError +
`readTurnFailedError` surface.) Remaining for weft-node: prevent built-in
OpenAI credentials from reaching custom Codex gateways in the Node runtime,
preserve structured error fields on synthetic `turn_failed` timeline items,
reject immediately-drained deferred sends with the original typed error, and
export `readTurnFailedError` / `TurnFailedErrorInfo` from the Node root entry.
