/**
 * FlitroProviderRuntimeDriver
 *
 * Sends messages to the Flitro Go server and routes permission responses back.
 * Aliases the shared `ProviderRuntimeDriver` contract (same as Claude/Codex),
 * so the three providers share one driver interface. Flitro additionally
 * exposes `getActiveRunId` as a host-internal helper for the tool-suspension
 * bridge — it is not part of the shared contract.
 */

import type { PermissionMode, } from '@weft/runtime-core'
import type { TimelineSequencer } from '@weft/timeline'
import type { ProviderRuntimeDriver, ProviderRuntimeDriverInput } from '../shared/runtime-scaffold.ts'
import type { WeftHttpClient } from './client/index.ts'

// NOTE: `permission_mode` → Flitro `approval_policy`/`permission_envelope`
// mapping no longer lives in the SDK. The SDK sends the canonical
// `permission_mode` and the Flitro agentd maps it to its own native params.
// The old `mapPermissionModeToApprovalPolicy` helper is removed.

/**
 * The Flitro driver is the shared `ProviderRuntimeDriver` contract plus
 * `getActiveRunId` (a host-internal helper for the tool-suspension bridge).
 * Assignable to `ProviderRuntimeDriver` everywhere the scaffold consumes it.
 */
export type FlitroProviderRuntimeDriver = ProviderRuntimeDriver & FlitroDriverRunId

/** Host-internal extension: the Flitro driver tracks the active run id so the
 *  tool-suspension bridge can resume it. Not part of `ProviderRuntimeDriver`. */
export interface FlitroDriverRunId {
  getActiveRunId?(): string | undefined
}

export interface CreateFlitroDriverOptions {
  client: WeftHttpClient
  sessionId: string
  /** LLM model override sent to Flitro */
  model?: string
  /** Skill names to activate for each message */
  skillNames?: string[]
  /** MCP server names to attach */
  mcpServerNames?: string[]
  /** Default permission_mode ('explore' | 'ask' | 'auto') used when a per-message mode is unset. */
  permissionMode?: PermissionMode
}

/**
 * Creates a runtime driver that delegates to the Flitro server.
 *
 * sendMessage creates a Flitro Run (one message = one turn = one Run).
 * The timeline events flow back via the SSE stream set up separately.
 */
export function createFlitroDriver(
  options: CreateFlitroDriverOptions,
): FlitroProviderRuntimeDriver {
  let activeRunId: string | undefined

  const driver: FlitroProviderRuntimeDriver = {
    async sendMessage(input: ProviderRuntimeDriverInput, _sequencer: TimelineSequencer) {
      const run = await options.client.createRun(
        options.sessionId,
        input.message,
        {
          model: input.options?.model ?? options.model,
          skillNames: options.skillNames,
          mcpServerNames: options.mcpServerNames,
          // Per-message permission_mode (from the chat panel selector) wins
          // over the runtime's creation-time default. The canonical value is
          // forwarded as-is; the Flitro agentd maps it to approval_policy /
          // permission_envelope.
          permissionMode: input.options?.permissionMode ?? options.permissionMode,
        },
      )
      activeRunId = run.run_id
    },

    async abort(_reason?: string) {
      if (activeRunId) {
        await options.client.cancelRun(options.sessionId, activeRunId).catch(() => {})
        activeRunId = undefined
      }
    },

    async respondToPermission(requestId, allowed, remember, detail) {
      await options.client.respondToPermission(options.sessionId, requestId, allowed, {
        remember,
        detail,
      })
    },

    getActiveRunId() {
      return activeRunId
    },

    async dispose() {
      if (activeRunId) {
        await options.client.cancelRun(options.sessionId, activeRunId).catch(() => {})
        activeRunId = undefined
      }
    },
  }
  return driver
}
