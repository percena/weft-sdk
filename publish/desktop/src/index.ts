/**
 * weft-node — local Coding Agent SDK root entry.
 *
 * Exports the shared integration surface: runtime/timeline types, React chat
 * hooks and components, and i18n fallback. Symmetric with `@percena/weft`'s
 * root entry so consumers can migrate by changing only the package specifier.
 *
 * For the full chat UI: import from '@percena/weft-node/chat'.
 * For the local headless runtime: import from '@percena/weft-node/runtime'.
 */

// --- Runtime + timeline types (centralized in runtime-types.ts) ---
export * from './runtime-types.ts'

// --- Hosted-mode React integration (bundled from workspace package) ---
export { useAgentSession } from '@weft/chat'
export type { UseAgentSessionOptions, AgentSession } from '@weft/chat'
export { TimelineAgentChatPanel, AgentChatPanel, useTimelineAgentChatSession, useAgentChatSession } from '@weft/chat'
export { EN_FALLBACK } from '@weft/ui/lib/en-fallback'
