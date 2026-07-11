# integrate-weft-kit

A [Claude Agent Skill](https://docs.claude.com/en/docs/agents-and-tools/agent-skills) that makes a REST API agentic with [`@percena/weft`](https://www.npmjs.com/package/@percena/weft): an LLM agent drives your REST API through an embedded chat panel, operating the same endpoints the page uses.

It is **not a one-shot recipe** — it is a **closed-loop feedback system** (build → headed-Playwright test → self-repair → repeat until green) around a language-agnostic **integration contract**. Two layers must be correct: **integration wiring** (provisioning + browser SDK + tools from your OpenAPI spec) and **behavioral model** (per-resource state machine + API dependency DAG).

The skill is **self-contained**. After install, the runbook + `templates/` + `references/` are enough — no monorepo or demo layout is required.

## Install

```bash
# into the current project's agent skills dir (recommended)
npx skills add percena/weft-sdk

# or globally
npx skills add -g percena/weft-sdk
```

`npx skills add` always pulls the default-branch latest. To pin a version for reproducibility, commit the installed skill into your project (project-scope) or use the experimental lock-file flow:

```bash
npx skills experimental_install # restore from a committed skills-lock.json
```

## What you get

| Path | Role |
|---|---|
| `SKILL.md` | The closed-loop contract + test categories + runbook (Node + Python). |
| `templates/*.mjs` | Node fast-path: `provision.mjs`, `session-routes.mjs`, `run.mjs`, `ChatPane.tsx`, `chat-bootstrap.ts`, `auth-context.tsx`, `customer.ts`, `.env.example`, `security.test.mjs`. |
| `templates/python/` | Python/FastAPI fast-path: `provision.py`, `session_routes.py`, `run.py`, `system_prompt.py`, `weft.py`, `test_session_routes_security.py`. |
| `references/security-contract.md` | The canonical trust model + Tier-1 enforced defaults + Tier-2 SDK-enforced + Tier-3 integrator responsibilities + OWASP mapping. |
| `references/fail-open.md` | Why a wrong DAG never blocks a legitimate call. |
| `references/plan-route-veto.md` | How the graph sequences calls (and what it does not carry). |
| `references/execution-model.md` | The `execution: server|client` reachability decider. |
| `CHANGELOG.md` | Semantic version history (independent of the SDK). |

## Requirements

- `@percena/weft` ^1.0.1
- A REST API with an OpenAPI/swagger spec
- Node 20+ **or** Python 3.11+
- A Weft control-plane (`weftd`) tenant, provisioned at [https://weft-kit.dev](https://weft-kit.dev)

## Security

The templates ship **secure-by-default** (Tier-1: auth 401, ownership fail-closed 403, `end_user_id` from cookie, proxy header allowlist + path-normalize + body cap, SSE cap, CORS per-request). The executable guards (`security.test.mjs` / `test_session_routes_security.py`) verify them — run in CI. **Do not weaken the defaults**; see [`references/security-contract.md`](references/security-contract.md) for the full contract + the Tier-3 integrator responsibilities the guard cannot verify.

## Versioning

This skill uses **independent semantic versioning** (see [`CHANGELOG.md`](CHANGELOG.md)). The current version is in `SKILL.md`'s frontmatter `metadata.version`; `metadata.min-weft-sdk` declares the minimum SDK version. A breaking change to the integration contract, placeholder set, or a Tier-1 security default is a major bump.

## License

[MIT](https://github.com/percena/weft-sdk/blob/main/LICENSE) — same license as the `weft-sdk` repository.
