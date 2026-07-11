/**
 * weft — Agentic Chat SDK root entry.
 *
 * Exports the Tenant-facing integration surface: runtime types, hosted-mode
 * React hooks and components, timeline event types, and i18n fallback.
 *
 * For the full chat UI: import from '@percena/weft/chat'.
 * For headless (no React): import from '@percena/weft/providers/flitro'.
 */

// --- Runtime + timeline types (centralized in runtime-types.ts) ---
export * from './runtime-types.ts'

// --- Hosted-mode React integration (bundled from workspace package) ---
export { useAgentSession } from '@weft/chat'
export type { UseAgentSessionOptions, AgentSession } from '@weft/chat'
export { createFlitroEmbedRuntime, type CreateFlitroEmbedRuntimeOptions } from '@weft/providers/flitro'
export { TimelineAgentChatPanel, AgentChatPanel, useTimelineAgentChatSession, useAgentChatSession } from '@weft/chat'
export { EN_FALLBACK } from '@weft/ui/lib/en-fallback'
