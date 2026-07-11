/**
 * Offline trace parsers — replay persisted provider output (Codex rollout
 * JSONL, claude -p stdout) as canonical AgentEvents, ready for timeline
 * projection. Browser-safe: no Node built-ins.
 */

export { TraceEventAdapter } from './base-event-adapter.ts'
export {
  TraceToolIndex,
  parseTraceReadCommand,
  generateTraceTurnId,
  generateTraceToolUseId,
  type TraceToolEntry,
  type TraceReadCommandInfo,
} from './support.ts'
export { ClaudeStdoutAdapter, parseClaudeStdoutTrace } from './claude-stdout.ts'
export { CodexRolloutAdapter, parseCodexRolloutTrace, type RolloutEvent } from './codex-rollout.ts'
