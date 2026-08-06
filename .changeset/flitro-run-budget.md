---
"@percena/weft": minor
---

Run budgets can now be set from the public SDK surface, not just the low-level
`WeftApiClient.createRun` call. A `budget` option
(`{ maxSteps?, maxTokens?, maxWallTimeSec? }`, typed as `RunBudget`) is
accepted:

- per message, via `SendMessageOptions.budget`;
- as a session-level default, via `CreateFlitroEmbedRuntimeOptions.budget`
  (also on `CreateFlitroProviderRuntimeOptions` / `CreateFlitroDriverOptions`).

The Flitro runtime-driver forwards it to the server when creating a run
(serialized to `max_steps` / `max_tokens` / `max_wall_time_sec`), so hosts can
cap long agentic flows client-side. A per-message budget wins over the session
default, mirroring `permissionMode`. The option is honored by the Flitro
driver; other providers may ignore it.
