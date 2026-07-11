import { stableHash } from './shared-utils.ts'

export interface LocalMcpEnvironmentScrubOptions {
  keepKeys?: string[]
  removeKeyPattern?: RegExp
}

export interface LocalMcpEnvironmentScrubResult {
  env: Record<string, string>
  removedKeys: string[]
  redactedPreview: Record<string, string>
}

const DEFAULT_SECRET_ENV_KEY_PATTERN = /(token|api[_-]?key|secret|password|passwd|credential|authorization|auth)$/i

export function scrubLocalMcpEnvironment(
  env: Record<string, string | undefined>,
  options: LocalMcpEnvironmentScrubOptions = {},
): LocalMcpEnvironmentScrubResult {
  const keepKeys = new Set(options.keepKeys ?? [])
  const removeKeyPattern = options.removeKeyPattern ?? DEFAULT_SECRET_ENV_KEY_PATTERN
  const scrubbed: Record<string, string> = {}
  const redactedPreview: Record<string, string> = {}
  const removedKeys: string[] = []

  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue
    if (!keepKeys.has(key) && removeKeyPattern.test(key)) {
      removedKeys.push(key)
      redactedPreview[key] = '[REDACTED]'
      continue
    }
    scrubbed[key] = value
    redactedPreview[key] = value
  }

  removedKeys.sort()
  return {
    env: scrubbed,
    removedKeys,
    redactedPreview,
  }
}

export type ConfigKind =
  | 'automation'
  | 'source'
  | 'skill'
  | 'policy'
  | 'status'
  | 'preference'
  | 'tool-registry'

export type ConfigRecoveryProblem =
  | 'malformed_json'
  | 'schema_invalid'
  | 'missing_default'
  | 'unknown'

export type ConfigRecoveryAction =
  | 'fallback_to_default'
  | 'migrate_aliases'
  | 'backfill_ids'
  | 'skip_invalid_user_config'
  | 'none'

export interface ConfigRecoveryReceiptInput {
  configPath: string
  configKind: ConfigKind
  problem: ConfigRecoveryProblem
  recovery: ConfigRecoveryAction
  defaultVersion?: string
  userConfigHash?: string
  migratedAliases?: string[]
  matcherIdsBackfilled?: string[]
  timestamp?: number
}

export interface ConfigRecoveryReceipt extends ConfigRecoveryReceiptInput {
  receiptId: string
  overwroteUserConfig: false
  migratedAliases: string[]
  matcherIdsBackfilled: string[]
}

export function createConfigRecoveryReceipt(
  input: ConfigRecoveryReceiptInput,
): ConfigRecoveryReceipt {
  const migratedAliases = [...(input.migratedAliases ?? [])].sort()
  const matcherIdsBackfilled = [...(input.matcherIdsBackfilled ?? [])].sort()
  const body = {
    configPath: input.configPath,
    configKind: input.configKind,
    problem: input.problem,
    recovery: input.recovery,
    defaultVersion: input.defaultVersion,
    userConfigHash: input.userConfigHash,
    migratedAliases,
    matcherIdsBackfilled,
    timestamp: input.timestamp,
  }

  return {
    ...body,
    receiptId: `config-recovery:${stableHash(body)}`,
    overwroteUserConfig: false,
    migratedAliases,
    matcherIdsBackfilled,
  }
}

export type ResourceBundleKind =
  | 'source'
  | 'skill'
  | 'automation'
  | 'policy'
  | 'status'
  | 'preference'

export interface ResourceBundleEntry {
  path: string
  kind: ResourceBundleKind
  contentHash: string
  version?: string
}

export interface ResourceBundleSnapshotInput {
  workspaceId: string
  resources: ResourceBundleEntry[]
  timestamp?: number
}

export interface ResourceBundleSnapshot {
  snapshotId: string
  workspaceId: string
  resourceCount: number
  resources: ResourceBundleEntry[]
  timestamp?: number
}

export function createResourceBundleSnapshot(
  input: ResourceBundleSnapshotInput,
): ResourceBundleSnapshot {
  const resources = [...input.resources]
    .map(resource => ({ ...resource }))
    .sort((left, right) => left.path.localeCompare(right.path))
  const body = {
    workspaceId: input.workspaceId,
    resources,
    timestamp: input.timestamp,
  }

  return {
    snapshotId: `resource-bundle:${stableHash(body)}`,
    workspaceId: input.workspaceId,
    resourceCount: resources.length,
    resources,
    ...(input.timestamp !== undefined ? { timestamp: input.timestamp } : {}),
  }
}

export type ConfigWatchAction = 'created' | 'updated' | 'deleted' | 'renamed'
export type ConfigWatchSource = 'file_watcher' | 'ui' | 'cli' | 'migration' | 'recovery'

export interface ConfigWatchEventInput {
  workspaceId: string
  configPath: string
  configKind: ConfigKind
  action: ConfigWatchAction
  source: ConfigWatchSource
  timestamp: number
  previousHash?: string
  nextHash?: string
}

export interface ConfigWatchEvent extends ConfigWatchEventInput {
  eventId: string
}

export function createConfigWatchEvent(input: ConfigWatchEventInput): ConfigWatchEvent {
  const body = { ...input }
  return {
    ...body,
    eventId: `config-watch:${stableHash(body)}`,
  }
}
