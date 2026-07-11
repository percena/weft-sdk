# Weft Skills

Agent skills for the [`@percena/weft`](https://github.com/percena/weft-sdk) Agentic Chat SDK.

## Install

The CLI auto-detects your agent (Claude Code, Codex, Cursor, …) and installs into the right location.

Install all skills into your project:

```sh
npx skills add percena/weft-sdk
```

Install a single skill:

```sh
npx skills add percena/weft-sdk --skill integrate-weft-kit
```

Target a specific agent (e.g. Codex):

```sh
npx skills add percena/weft-sdk -a codex
```

Install globally (user-level — `~/.claude/skills/`, `~/.codex/skills/`, …):

```sh
npx skills add -g percena/weft-sdk
```

## Skills

- **`integrate-weft-kit`** — Integrate `@percena/weft` into a REST API project that has an OpenAPI/swagger spec: embed a chat panel whose LLM agent drives the project's REST API. Covers the per-resource state machine and API dependency graph (DAG) modeling/generation/review.

### Where the source of truth lives

After install, the skill package is enough (no monorepo checkout required).
In this repository the layout is:

| Path | Role |
|------|------|
| [`integrate-weft-kit/SKILL.md`](integrate-weft-kit/SKILL.md) | Closed-loop runbook + integration contract |
| [`integrate-weft-kit/references/`](integrate-weft-kit/references/) | Security contract, fail-open DAG, plan-route, execution model |
| [`integrate-weft-kit/templates/`](integrate-weft-kit/templates/) | Node + Python templates + executable security guards |

SDK-layer threat model (browser embed, credentials, XSS, CORS) lives in the
repo docs: [`docs/SECURITY-MODEL.md`](../docs/SECURITY-MODEL.md). Integration-layer
invariants for the templates live in
[`integrate-weft-kit/references/security-contract.md`](integrate-weft-kit/references/security-contract.md).
