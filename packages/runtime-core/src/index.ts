/**
 * @weft/runtime-core — provider-neutral agent runtime contracts.
 *
 * Split by abstraction level (2026-07-12 architecture review, finding B1):
 * - contract.ts       — the public AgentRuntime contract: kinds, statuses,
 *                       auth/candidate/capability types, SendMessageOptions,
 *                       policy hook types, extension context, streams.
 * - state.ts          — the runtime state machine (state, actions, reducer).
 * - host-tools.ts     — the host session-tool bridge DTOs + invokeSessionTool.
 * - codex-mappings.ts — codex permission-mode mappings stranded here by the
 *                       cli-runtime → providers dependency direction; slated
 *                       to move into a codex adapter (see module header).
 *
 * The barrel re-exports everything, so the public API is unchanged.
 */
export * from './contract.ts'
export * from './state.ts'
export * from './host-tools.ts'
export * from './codex-mappings.ts'
