import { createHash } from 'node:crypto'
import { stableHash, stableStringify, cloneCommandOrigin } from './shared-utils.ts'
import type { ToolOutputReceipt, ToolOutputPolicy } from './tool-output-policy.ts'
import { createToolOutputPolicy } from './tool-output-policy.ts'
import type { InMemoryCommandOrigin } from './session-tool-bridge.ts'
import type { RemoteCommandOrigin } from './messaging.ts'

export type RuntimeKind = 'claude' | 'codex' | 'hosted' | 'mcp' | 'cli'
export type RuntimeSupportLevel = 'supported' | 'degraded' | 'unsupported'
export type HostUtilityCategory =
  | 'validation'
  | 'rendering'
  | 'sandbox'
  | 'browser'
  | 'secondary_llm'
  | 'metadata'
  | 'messaging'
  | 'source'

export interface HostUtilityToolRegistration {
  name: string
  category: HostUtilityCategory
  schemaVersion: string
  featureFlags?: string[]
  safeMode?: boolean
  readOnly?: boolean
  runtimeSupport: Partial<Record<RuntimeKind, RuntimeSupportLevel>>
}

export interface RuntimeSupportGap {
  name: string
  runtimeKind: RuntimeKind
}

export interface ToolRegistryVersionInput {
  registryVersion: string
  tools: HostUtilityToolRegistration[]
}

export interface ToolRegistryVersion {
  registryId: string
  registryVersion: string
  toolCount: number
  tools: HostUtilityToolRegistration[]
  degraded: RuntimeSupportGap[]
  unsupported: RuntimeSupportGap[]
}

const RUNTIME_KIND_ORDER: RuntimeKind[] = ['claude', 'codex', 'hosted', 'mcp', 'cli']

export function createToolRegistryVersion(
  input: ToolRegistryVersionInput,
): ToolRegistryVersion {
  const tools = [...input.tools]
    .map(tool => ({
      ...tool,
      ...(tool.featureFlags ? { featureFlags: [...tool.featureFlags].sort() } : {}),
      runtimeSupport: { ...tool.runtimeSupport },
    }))
    .sort((left, right) => left.name.localeCompare(right.name))
  const unsupported = collectRuntimeSupportGaps(tools, 'unsupported')
  const degraded = collectRuntimeSupportGaps(tools, 'degraded')
  const body = {
    registryVersion: input.registryVersion,
    tools,
  }

  return {
    registryId: `tool-registry:${stableHash(body)}`,
    registryVersion: input.registryVersion,
    toolCount: tools.length,
    tools,
    degraded,
    unsupported,
  }
}

function collectRuntimeSupportGaps(
  tools: HostUtilityToolRegistration[],
  level: RuntimeSupportLevel,
): RuntimeSupportGap[] {
  const gaps: RuntimeSupportGap[] = []
  for (const tool of tools) {
    const runtimeKinds = [...RUNTIME_KIND_ORDER].sort()
    for (const runtimeKind of runtimeKinds) {
      if (tool.runtimeSupport[runtimeKind] === level) {
        gaps.push({ name: tool.name, runtimeKind })
      }
    }
  }
  return gaps
}

export interface StatusDefinition {
  id: string
  label: string
  terminal?: boolean
}

export interface StatusTransitionDefinition {
  from: string
  to: string
}

export interface StatusConfig {
  statuses: StatusDefinition[]
  initialStatus: string
  allowedTransitions?: StatusTransitionDefinition[]
}

export interface ConfigDiagnostic {
  file: string
  path: string
  message: string
  severity: 'error' | 'warning'
  suggestion?: string
}

export interface StatusConfigValidationResult {
  valid: boolean
  errors: ConfigDiagnostic[]
  warnings: ConfigDiagnostic[]
}

export function validateStatusConfig(
  config: StatusConfig,
  file = 'statuses.json',
): StatusConfigValidationResult {
  const errors: ConfigDiagnostic[] = []
  const warnings: ConfigDiagnostic[] = []
  const statusIds = new Set<string>()

  config.statuses.forEach((status, index) => {
    if (!status.id) {
      errors.push({
        file,
        path: `statuses[${index}].id`,
        message: 'Status id is required',
        severity: 'error',
      })
      return
    }
    if (statusIds.has(status.id)) {
      errors.push({
        file,
        path: `statuses[${index}].id`,
        message: 'Status id must be unique',
        severity: 'error',
      })
      return
    }
    statusIds.add(status.id)
  })

  const initial = config.statuses.find(status => status.id === config.initialStatus)
  if (!initial) {
    errors.push({
      file,
      path: 'initialStatus',
      message: 'Initial status is not defined',
      severity: 'error',
    })
  } else if (initial.terminal) {
    errors.push({
      file,
      path: 'initialStatus',
      message: 'Initial status cannot be terminal',
      severity: 'error',
    })
  }

  for (const [index, transition] of (config.allowedTransitions ?? []).entries()) {
    if (!statusIds.has(transition.from)) {
      errors.push({
        file,
        path: `allowedTransitions[${index}].from`,
        message: 'Transition source status is not defined',
        severity: 'error',
      })
    }
    if (!statusIds.has(transition.to)) {
      errors.push({
        file,
        path: `allowedTransitions[${index}].to`,
        message: 'Transition target status is not defined',
        severity: 'error',
      })
    }
  }

  if (!config.statuses.some(status => status.terminal)) {
    warnings.push({
      file,
      path: 'statuses',
      message: 'Status config has no terminal status',
      severity: 'warning',
      suggestion: 'Add at least one terminal status such as done or archived.',
    })
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  }
}

export interface SandboxProfile {
  filesystem: 'none' | 'read-only' | 'workspace-write' | 'artifact-write'
  network: 'none' | 'loopback' | 'restricted' | 'full'
  allowedRuntimes: string[]
  timeoutMs: number
  envScrubbedKeys: string[]
  artifactWriteRoot?: string
}

export interface HostUtilityToolDescriptor extends HostUtilityToolRegistration {
  sandboxProfile?: SandboxProfile
}

export type HostUtilityPolicyDecision =
  | { decision: 'allow'; reason?: string }
  | { decision: 'deny'; reason: string }
  | { decision: 'ask'; reason: string }

export type HostUtilityExitStatus = 'success' | 'failed' | 'unsupported' | 'denied'

export interface HostUtilityHandlerResult {
  text: string
  exitStatus?: Exclude<HostUtilityExitStatus, 'denied' | 'unsupported'>
  metadata?: Record<string, unknown>
}

export interface HostUtilityHandlerContext {
  callId: string
  commandOrigin?: InMemoryCommandOrigin | RemoteCommandOrigin
}

export type HostUtilityHandler = (
  input: unknown,
  context: HostUtilityHandlerContext,
) => Promise<HostUtilityHandlerResult> | HostUtilityHandlerResult

export interface HostUtilityToolRegistrationInput {
  descriptor: HostUtilityToolDescriptor
  handler: HostUtilityHandler
}

export interface HostUtilityExecuteInput {
  toolName: string
  callId: string
  input: unknown
  commandOrigin?: InMemoryCommandOrigin | RemoteCommandOrigin
  policyDecision?: HostUtilityPolicyDecision
}

export interface UtilityToolReceipt {
  toolName: string
  callId: string
  inputDigest: string
  executionMode: 'host-service'
  sandboxProfile?: SandboxProfile
  output: ToolOutputReceipt
  durationMs: number
  startedAt: number
  finishedAt: number
  exitStatus: HostUtilityExitStatus
  policyDecision: HostUtilityPolicyDecision
  commandOrigin?: InMemoryCommandOrigin | RemoteCommandOrigin
  metadata?: Record<string, unknown>
}

export interface HostUtilityToolRegistry {
  register(input: HostUtilityToolRegistrationInput): void
  execute(input: HostUtilityExecuteInput): Promise<UtilityToolReceipt>
  capabilityReport(): ToolRegistryVersion
}

export interface InMemoryHostUtilityToolRegistryOptions {
  now?: () => number
  outputPolicy?: ToolOutputPolicy
  registryVersion?: string
}

export function createInMemoryHostUtilityToolRegistry(
  options: InMemoryHostUtilityToolRegistryOptions = {},
): HostUtilityToolRegistry {
  const now = options.now ?? Date.now
  const outputPolicy = options.outputPolicy ?? createToolOutputPolicy()
  const tools = new Map<string, HostUtilityToolRegistrationInput>()

  return {
    register(input) {
      tools.set(input.descriptor.name, cloneUtilityRegistration(input))
    },

    async execute(input) {
      const startedAt = now()
      const policyDecision = input.policyDecision ?? { decision: 'allow' as const }
      const descriptor = tools.get(input.toolName)?.descriptor

      if (policyDecision.decision !== 'allow') {
        return createUtilityReceipt({
          input,
          descriptor,
          startedAt,
          finishedAt: now(),
          text: policyDecision.reason,
          exitStatus: 'denied',
          policyDecision,
          outputPolicy,
        })
      }

      const registration = tools.get(input.toolName)
      if (!registration) {
        return createUtilityReceipt({
          input,
          startedAt,
          finishedAt: now(),
          text: 'host utility tool is not registered',
          exitStatus: 'unsupported',
          policyDecision,
          outputPolicy,
        })
      }

      try {
        const result = await registration.handler(input.input, {
          callId: input.callId,
          ...(input.commandOrigin ? { commandOrigin: cloneCommandOrigin(input.commandOrigin) } : {}),
        })
        return createUtilityReceipt({
          input,
          descriptor: registration.descriptor,
          startedAt,
          finishedAt: now(),
          text: result.text,
          exitStatus: result.exitStatus ?? 'success',
          policyDecision,
          outputPolicy,
          metadata: result.metadata,
        })
      } catch (error) {
        return createUtilityReceipt({
          input,
          descriptor: registration.descriptor,
          startedAt,
          finishedAt: now(),
          text: error instanceof Error ? error.message : String(error),
          exitStatus: 'failed',
          policyDecision,
          outputPolicy,
        })
      }
    },

    capabilityReport() {
      return createToolRegistryVersion({
        registryVersion: options.registryVersion ?? 'in-memory',
        tools: [...tools.values()].map(tool => tool.descriptor),
      })
    },
  }
}

function createUtilityReceipt(input: {
  input: HostUtilityExecuteInput
  descriptor?: HostUtilityToolDescriptor
  startedAt: number
  finishedAt: number
  text: string
  exitStatus: HostUtilityExitStatus
  policyDecision: HostUtilityPolicyDecision
  outputPolicy: ToolOutputPolicy
  metadata?: Record<string, unknown>
}): UtilityToolReceipt {
  const output = input.outputPolicy.process({
    callId: input.input.callId,
    toolName: input.input.toolName,
    text: input.text,
    intent: input.descriptor?.category,
  })
  return {
    toolName: input.input.toolName,
    callId: input.input.callId,
    inputDigest: `sha256:${createHash('sha256').update(stableStringify(input.input.input), 'utf8').digest('hex')}`,
    executionMode: 'host-service',
    ...(input.descriptor?.sandboxProfile ? { sandboxProfile: cloneSandboxProfile(input.descriptor.sandboxProfile) } : {}),
    output,
    durationMs: input.finishedAt - input.startedAt,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    exitStatus: input.exitStatus,
    policyDecision: { ...input.policyDecision },
    ...(input.input.commandOrigin ? { commandOrigin: cloneCommandOrigin(input.input.commandOrigin) } : {}),
    ...(input.metadata ? { metadata: { ...input.metadata } } : {}),
  }
}

function cloneUtilityRegistration(
  input: HostUtilityToolRegistrationInput,
): HostUtilityToolRegistrationInput {
  return {
    descriptor: cloneHostUtilityDescriptor(input.descriptor),
    handler: input.handler,
  }
}

function cloneHostUtilityDescriptor(descriptor: HostUtilityToolDescriptor): HostUtilityToolDescriptor {
  return {
    ...descriptor,
    ...(descriptor.featureFlags ? { featureFlags: [...descriptor.featureFlags] } : {}),
    runtimeSupport: { ...descriptor.runtimeSupport },
    ...(descriptor.sandboxProfile ? { sandboxProfile: cloneSandboxProfile(descriptor.sandboxProfile) } : {}),
  }
}

function cloneSandboxProfile(profile: SandboxProfile): SandboxProfile {
  return {
    ...profile,
    allowedRuntimes: [...profile.allowedRuntimes],
    envScrubbedKeys: [...profile.envScrubbedKeys],
  }
}
