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
