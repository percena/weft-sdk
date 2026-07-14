/**
 * @weft/adapter — provider auth detection.
 *
 * B8 (2026-07-12 architecture review): this package previously carried a
 * ~8k-line legacy "Agent Backend Abstraction Layer" (AgentBackend, EventQueue,
 * ToolIndex, bash/powershell validators, interceptors, stubs) left over from a
 * pre-`@weft/providers` migration. None of it was imported anywhere in the
 * workspace; it has been deleted. The live surface is the auth module:
 * provider-owned Claude/Codex auth probes consumed by `@weft/cli-runtime`,
 * `@weft/providers/factory` (detectRuntimeCandidates), and the
 * `@percena/weft-node` facade.
 */
export * from './auth/index.ts'
export * from './models/index.ts'
