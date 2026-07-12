import type { PermissionMode } from '@weft/core'

/**
 * Codex-specific permission mappings.
 *
 * Ideally these live in `@weft/providers/codex`, but `@weft/cli-runtime` (L3)
 * uses them and `@weft/providers` (L4) depends on cli-runtime — moving them
 * would create a circular dependency. They are isolated in this module so the
 * neutral contract (contract.ts) stays provider-free; extract the module into
 * a codex adapter package once the cli-runtime → providers fold lands (see the
 * 2026-07-12 architecture review, finding B1).
 */

export interface CodexPermissionParams {
  approvalPolicy: string
  approvalsReviewer: string
  sandbox: string
}

/**
 * Canonical PermissionMode → Codex permission parameters mapping, shared by
 * the app-server driver (thread/start, turn/start), the host controller, and
 * the CLI fallback runtime. `sandbox` is a Codex `SandboxMode` string as used
 * by `thread/start` and `codex exec --sandbox`.
 *
 * SECURITY NOTE: `auto` maps to `danger-full-access` + `approvalPolicy:
 * "never"` — the agent runs unsandboxed with no approval prompts. This is the
 * codex equivalent of the Claude driver's `bypassPermissions` mapping and must
 * only be selected by an explicit, informed host decision.
 *
 * TODO(codex-agentd): move this mapping to the codex agentd adapter when it
 * exists. It belongs there (keyed off canonical `permission_mode`), not in the
 * SDK core — it is kept here only because codex agentd does not exist yet and
 * the app-server driver + cli-runtime still consume it. Resolution gate: once
 * the codex agentd adapter lands (see the codex app-server alignment tracker),
 * delete this function and consume the mapping from the adapter instead.
 */
export function mapPermissionModeToCodexParams(mode: PermissionMode): CodexPermissionParams {
  switch (mode) {
    case 'explore':
      return { approvalPolicy: 'untrusted', approvalsReviewer: 'user', sandbox: 'read-only' }
    case 'auto':
      return { approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: 'danger-full-access' }
    default:
      return { approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: 'workspace-write' }
  }
}

/**
 * Codex app-server v2 `turn/start` takes a tagged `SandboxPolicy` object,
 * unlike `thread/start` which takes a plain `SandboxMode` string. Variant
 * fields are all serde-defaulted, so the minimal `{ type }` form is valid.
 */
export function mapCodexSandboxModeToSandboxPolicy(sandbox: string): { type: string } {
  if (sandbox === 'read-only') return { type: 'readOnly' }
  if (sandbox === 'danger-full-access') return { type: 'dangerFullAccess' }
  return { type: 'workspaceWrite' }
}
