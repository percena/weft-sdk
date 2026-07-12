import type { ProviderAuthDetection } from '@weft/adapter/auth'
import type {
  AgentCommandSink,
  AgentEventStream,
  AgentRuntimeState,
  AgentRuntimeStatus,
  PermissionMode,
  RuntimeAction,
  SendMessageOptions,
} from '@weft/runtime-core'

export type CliAgentProvider = 'claude' | 'codex'

export interface CliAgentSessionOptions {
  provider: CliAgentProvider
  cwd: string
  sessionId?: string
  model?: string
  thinkingLevel?: string
  reasoningEffort?: string
  permissionMode?: PermissionMode
  executable?: string
  env?: Record<string, string>
  requestTimeoutMs?: number
  /**
   * A7: resume a persisted provider conversation across processes
   * (`claude -p --resume <id>` / `codex exec resume <id>`). Within a session
   * the id is captured automatically from the first turn's JSON stream and
   * surfaced as a `status` event (`provider_session:<id>`).
   */
  resumeSessionId?: string
}

export interface AgentSessionRuntime {
  readonly sessionId: string
  readonly provider: CliAgentProvider
  readonly events: AgentEventStream
  readonly commands: AgentCommandSink
  preflight(): Promise<ProviderAuthDetection>
  getState(): AgentRuntimeState
}

export type {
  AgentCommandSink,
  AgentEventStream,
  AgentRuntimeState,
  AgentRuntimeStatus,
  PermissionMode,
  RuntimeAction,
  SendMessageOptions,
}
