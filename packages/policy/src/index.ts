import { globMatches, parsePermissionMode } from '@weft/core'
import { isValidRegex } from './utils.ts'
import type { PermissionMode } from '@weft/core'
export type { PermissionMode }

export type ToolPolicyDecision =
  | { decision: 'allow' }
  | { decision: 'ask'; reason: string }
  | { decision: 'deny'; reason: string }

export type ToolIntent =
  | { kind: 'bash'; command: string; baseCommand: string }
  | { kind: 'file_write'; path: string; toolName: string }
  | { kind: 'mcp'; name: string }
  | { kind: 'api'; method: string; path: string; url?: string }
  | { kind: 'unknown'; toolName: string }

export interface PolicyRuleMatch {
  layerId: string
  ruleType: 'bash-pattern' | 'mcp-pattern' | 'api-endpoint' | 'write-path' | 'blocked-command-hint'
  pattern: string
}

export type ToolPolicyExplanation = ToolPolicyDecision & {
  intent: ToolIntent
  matchedRule?: PolicyRuleMatch
  hint?: string
  tryInstead?: string[]
  hintContext?: string
}

/**
 * Policy decision receipt — a full audit record for every allow/ask/deny decision.
 *
 * Each policy decision must produce a machine-readable receipt
 * with requestId, matchedRule, scope, origin, ttl, and explain, plus timelineRef
 * for cross-referencing with the canonical timeline.
 */
export interface PolicyDecisionReceipt {
  /** Unique request identifier for audit trail */
  requestId: string
  /** The policy decision (allow/ask/deny) */
  decision: ToolPolicyDecision
  /** Full explain output used to derive the receipt */
  explain: ToolPolicyExplanation
  /** The tool intent that was evaluated */
  intent: ToolIntent
  /** Which rule matched (if any) */
  matchedRule?: PolicyRuleMatch
  /** The scope in which the decision applies */
  scope?: PermissionScopeInput
  /** Who or what originated the request */
  origin?: PermissionApprovalOrigin
  /** How long the allow decision is valid (ms since epoch), if applicable */
  ttl?: number
  /** Blocked command hint for deny decisions */
  hint?: string
  /** Timeline envelope references for audit cross-referencing */
  timelineRefs?: Array<{ epoch: string; seq: number }>
}

export interface CreatePolicyDecisionReceiptOptions {
  requestId: string
  policy: PermissionPolicy
  request: ToolPolicyRequest
  origin?: PermissionApprovalOrigin
  ttl?: number
  timelineRefs?: Array<{ epoch: string; seq: number }>
}

export type PermissionScope =
  | { type: 'session'; sessionId: string }
  | { type: 'workspace'; workspaceId: string }
  | { type: 'source'; sourceSlug: string }
  | { type: 'skill'; skillSlug: string }
  | { type: 'automation'; automationId: string }
  | { type: 'tool-call'; callId: string }

export type PermissionScopeInput = string | PermissionScope

export type PermissionApprovalOrigin =
  | { type: 'user'; id?: string }
  | { type: 'automation'; id: string }
  | { type: 'system'; id?: string }

export interface AlwaysAllowRule {
  toolName: string
  scope?: PermissionScopeInput
}

export interface ApiEndpointRule {
  method: string
  pattern: string
}

export interface BlockedCommandHintRule {
  command: string
  reason: string
  whenNotMatching?: string
  tryInstead?: string[]
  context?: string
}

export interface PolicyRuleSet {
  allowedBashPatterns?: string[]
  allowedMcpPatterns?: string[]
  allowedApiEndpoints?: ApiEndpointRule[]
  allowedWritePaths?: string[]
  blockedCommandHints?: BlockedCommandHintRule[]
}

export interface PolicyLayer {
  id: string
  rules: PolicyRuleSet
  scope?: PermissionScopeInput
}

export interface PermissionApproval {
  id: string
  toolName: string
  scope: PermissionScope
  origin: PermissionApprovalOrigin
  createdAt?: number
  expiresAt?: number
}

export interface PermissionApprovalStore {
  remember(approval: PermissionApproval): void
  revoke(id: string): void
  snapshot(): PermissionApproval[]
}

export interface PermissionPolicy {
  mode: PermissionMode
  alwaysAllow: AlwaysAllowRule[]
  approvals: PermissionApproval[]
  layers: PolicyLayer[]
}

export interface CreatePermissionPolicyOptions {
  mode?: PermissionMode
  alwaysAllow?: AlwaysAllowRule[]
  approvals?: PermissionApproval[]
  layers?: PolicyLayer[]
}

export interface CreateSourcePolicyLayerOptions {
  sourceSlug: string
  rules: PolicyRuleSet
  id?: string
}

export interface PolicyConfigLayer {
  id: string
  sourceSlug?: string
  scope?: PermissionScopeInput
  rules: PolicyRuleSet
}

export interface PolicyConfigFile {
  mode?: PermissionMode
  alwaysAllow?: AlwaysAllowRule[]
  approvals?: PermissionApproval[]
  layers?: PolicyConfigLayer[]
}

export interface PolicyConfigIssue {
  path: string
  message: string
  suggestion?: string
}

export interface PolicyConfigValidationResult {
  valid: boolean
  errors: PolicyConfigIssue[]
  warnings: PolicyConfigIssue[]
}

export interface CreatePermissionPolicyFromConfigResult {
  validation: PolicyConfigValidationResult
  policy?: PermissionPolicy
}

export interface ToolPolicyRequest {
  toolName: string
  input?: Record<string, unknown>
  toolIntent?: ToolIntent
  scope?: PermissionScopeInput
}

export interface CreateApprovalStoreOptions {
  now?: () => number
}

const FILE_WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])

const DANGEROUS_BASH_COMMANDS = new Set([
  'rm',
  'rmdir',
  'sudo',
  'su',
  'chmod',
  'chown',
  'chgrp',
  'mv',
  'cp',
  'dd',
  'mkfs',
  'fdisk',
  'parted',
  'kill',
  'killall',
  'pkill',
  'reboot',
  'shutdown',
  'halt',
  'poweroff',
  'curl',
  'wget',
  'ssh',
  'scp',
  'rsync',
  // Shell-indirection / command-spawning heads: these run an arbitrary command
  // passed as an argument, so a naive base-command check would miss the real
  // (dangerous) command they carry (e.g. `bash -c 'rm -rf /'`, `xargs rm`).
  'bash',
  'sh',
  'zsh',
  'eval',
  'exec',
  'env',
  'xargs',
])

const READ_ONLY_BASH_PATTERNS = [
  /^git\s+status(\s|$)/,
  /^git\s+diff(\s|$)/,
  /^git\s+log(\s|$)/,
  /^ls(\s|$)/,
  /^pwd(\s|$)/,
  /^cat\s+/,
  /^sed\s+-n\s+/,
  /^rg(\s|$)/,
  /^find\s+/,
]

// Command chaining / substitution / redirection. A command containing any of
// these composes multiple invocations (or spawns a subshell), so a prefix that
// looks read-only (`cat x`) can be followed by anything (`cat x; rm -rf ~`).
// Presence of any of these disqualifies the read-only fast-path and forces the
// per-head danger check to inspect every composed command.
const SHELL_COMPOSITION = /[;&|`\n\r]|\$\(|<|>/

// Split a bash string into its composed command segments (on `;`, `|`, `&&`,
// `||`, `&`, newline) and return the "head" of each — the executed program with
// leading env-assignments (`FOO=1 rm`) and any directory prefix (`/bin/rm`)
// stripped, lowercased. Used to catch a dangerous command wherever it appears
// in a chain, not just at position zero.
function extractCommandHeads(command: string): string[] {
  return command
    .split(/\|\||&&|[;|&\n\r]/)
    .map((segment) => {
      const withoutEnv = segment.trim().replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, '')
      const first = withoutEnv.trim().split(/\s+/)[0] ?? ''
      return (first.split('/').pop() ?? '').toLowerCase()
    })
    .filter((head) => head.length > 0)
}

function isReadOnlyBashCommand(command: string): boolean {
  const trimmed = command.trim()
  // A composed command cannot be certified read-only — the read-only pattern
  // would only match the first segment.
  if (SHELL_COMPOSITION.test(trimmed)) return false
  return READ_ONLY_BASH_PATTERNS.some((pattern) => pattern.test(trimmed))
}

// A path escapes its allow-prefix if any segment is `..`. `globMatches` compiles
// `**` to `.*`, so `/workspace/**` matches `/workspace/../../etc/x`; and
// core's `normalizePath` only swaps backslashes (it does NOT resolve `..`), so
// the traversal must be rejected explicitly before the glob is consulted.
function hasPathTraversal(path: string): boolean {
  return path
    .replace(/\\/g, '/')
    .split('/')
    .some((segment) => segment === '..')
}

export function createPermissionPolicy(options: CreatePermissionPolicyOptions = {}): PermissionPolicy {
  return {
    mode: options.mode ?? 'ask',
    alwaysAllow: [...(options.alwaysAllow ?? [])],
    approvals: [...(options.approvals ?? [])],
    layers: [...(options.layers ?? [])],
  }
}

export function createSourcePolicyLayer(options: CreateSourcePolicyLayerOptions): PolicyLayer {
  return {
    id: options.id ?? `source:${options.sourceSlug}`,
    rules: {
      ...options.rules,
      allowedMcpPatterns: options.rules.allowedMcpPatterns?.map(pattern =>
        scopeMcpPatternToSource(options.sourceSlug, pattern),
      ),
    },
  }
}

export function validatePolicyConfig(input: unknown): PolicyConfigValidationResult {
  const errors: PolicyConfigIssue[] = []
  const warnings: PolicyConfigIssue[] = []
  const config = asRecord(input)

  const mode = config.mode
  if (mode !== undefined) {
    const normalized = typeof mode === 'string' ? parsePermissionMode(mode) : null
    if (normalized === null) {
      errors.push({
        path: 'mode',
        message: `Invalid permission mode: ${String(mode)}`,
        suggestion: 'Use one of: explore, ask, auto',
      })
    } else {
      // Propagate the canonical mode so downstream `=== 'explore'`/`'ask'`/
      // `'auto'` comparisons (and createPermissionPolicyFromConfig, which
      // reads `mode` off the same config object) see the renamed value, not a
      // legacy alias like `safe`/`allow-all`/`execute`.
      config.mode = normalized
    }
  }

  if (config.layers !== undefined && !Array.isArray(config.layers)) {
    errors.push({
      path: 'layers',
      message: 'Expected layers to be an array',
    })
  }

  if (Array.isArray(config.layers)) {
    config.layers.forEach((layerValue, layerIndex) => {
      const layer = asRecord(layerValue)
      const basePath = `layers[${layerIndex}]`
      if (typeof layer.id !== 'string' || layer.id.length === 0) {
        errors.push({
          path: `${basePath}.id`,
          message: 'Layer id is required',
        })
      }

      validateRuleSet(layer.rules, `${basePath}.rules`, errors)
    })
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  }
}

export function createPermissionPolicyFromConfig(
  input: unknown,
): CreatePermissionPolicyFromConfigResult {
  const validation = validatePolicyConfig(input)
  if (!validation.valid) return { validation }

  const config = asRecord(input) as PolicyConfigFile
  return {
    validation,
    policy: createPermissionPolicy({
      mode: config.mode,
      alwaysAllow: config.alwaysAllow,
      approvals: config.approvals,
      layers: (config.layers ?? []).map(layer =>
        layer.sourceSlug
          ? createSourcePolicyLayer({
            id: layer.id,
            sourceSlug: layer.sourceSlug,
            rules: layer.rules,
          })
          : {
            id: layer.id,
            rules: layer.rules,
            scope: layer.scope,
          },
      ),
    }),
  }
}

export function evaluateToolPolicy(policy: PermissionPolicy, request: ToolPolicyRequest): ToolPolicyDecision {
  const explanation = explainToolPolicy(policy, request)
  if (explanation.decision === 'allow') return { decision: 'allow' }
  return {
    decision: explanation.decision,
    reason: explanation.reason,
  }
}

export function createPolicyDecisionReceipt(
  options: CreatePolicyDecisionReceiptOptions,
): PolicyDecisionReceipt {
  const explanation = explainToolPolicy(options.policy, options.request)
  const decision: ToolPolicyDecision = explanation.decision === 'allow'
    ? { decision: 'allow' }
    : { decision: explanation.decision, reason: explanation.reason }

  return {
    requestId: options.requestId,
    decision,
    explain: explanation,
    intent: explanation.intent,
    ...(explanation.matchedRule ? { matchedRule: explanation.matchedRule } : {}),
    ...(options.request.scope ? { scope: options.request.scope } : {}),
    ...(options.origin ? { origin: options.origin } : {}),
    ...(options.ttl !== undefined ? { ttl: options.ttl } : {}),
    ...(explanation.hint ? { hint: explanation.hint } : {}),
    ...(options.timelineRefs ? { timelineRefs: options.timelineRefs } : {}),
  }
}

export function explainToolPolicy(policy: PermissionPolicy, request: ToolPolicyRequest): ToolPolicyExplanation {
  const intent = normalizeToolIntent(request)

  if (matchesApproval(policy, request)) {
    return { decision: 'allow', intent }
  }

  if (matchesAlwaysAllow(policy, request)) {
    return { decision: 'allow', intent }
  }

  if (policy.mode === 'auto') {
    return { decision: 'allow', intent }
  }

  const layeredAllow = findLayeredAllow(policy, intent, request.scope)
  if (layeredAllow) {
    return {
      decision: 'allow',
      intent,
      matchedRule: layeredAllow,
    }
  }

  if (intent.kind === 'file_write') {
    if (policy.mode === 'ask') {
      return {
        decision: 'ask',
        reason: `${intent.toolName} requires approval in ask mode`,
        intent,
      }
    }
    return {
      decision: 'deny',
      reason: `${intent.toolName} is blocked in explore mode`,
      intent,
    }
  }

  if (intent.kind === 'bash') {
    return evaluateBashPolicy(policy, intent)
  }

  if (intent.kind === 'mcp' && policy.mode === 'explore') {
    return {
      decision: 'deny',
      reason: `MCP tool is blocked in explore mode: ${intent.name}`,
      intent,
    }
  }

  if (intent.kind === 'api' && policy.mode === 'explore') {
    return {
      decision: 'deny',
      reason: `API endpoint is blocked in explore mode: ${intent.method} ${intent.path}`,
      intent,
    }
  }

  return { decision: 'allow', intent }
}

export function createInMemoryApprovalStore(options: CreateApprovalStoreOptions = {}): PermissionApprovalStore {
  const approvals = new Map<string, PermissionApproval>()
  const now = options.now ?? Date.now

  return {
    remember(approval) {
      approvals.set(approval.id, {
        ...approval,
        createdAt: approval.createdAt ?? now(),
      })
    },
    revoke(id) {
      approvals.delete(id)
    },
    snapshot() {
      const currentTime = now()
      return [...approvals.values()].filter(approval => !approval.expiresAt || approval.expiresAt > currentTime)
    },
  }
}

function matchesApproval(policy: PermissionPolicy, request: ToolPolicyRequest): boolean {
  const requestScope = scopeKey(request.scope)
  return policy.approvals.some((approval) => (
    approval.toolName === request.toolName && scopeKey(approval.scope) === requestScope
  ))
}

function matchesAlwaysAllow(policy: PermissionPolicy, request: ToolPolicyRequest): boolean {
  const requestScope = scopeKey(request.scope)
  return policy.alwaysAllow.some((rule) => {
    if (rule.toolName !== request.toolName) return false
    if (!rule.scope) return true
    return scopeKey(rule.scope) === requestScope
  })
}

function scopeKey(scope?: PermissionScopeInput): string {
  if (!scope) return 'global'
  if (typeof scope === 'string') return scope

  switch (scope.type) {
    case 'session':
      return `session:${scope.sessionId}`
    case 'workspace':
      return `workspace:${scope.workspaceId}`
    case 'source':
      return `source:${scope.sourceSlug}`
    case 'skill':
      return `skill:${scope.skillSlug}`
    case 'automation':
      return `automation:${scope.automationId}`
    case 'tool-call':
      return `tool-call:${scope.callId}`
  }
}

function evaluateBashPolicy(policy: PermissionPolicy, intent: ToolIntent): ToolPolicyExplanation {
  if (intent.kind !== 'bash') {
    return { decision: 'allow', intent }
  }

  if (policy.mode === 'ask') {
    // Inspect every composed command head, not just position zero, so a
    // dangerous command anywhere in a chain (`git status && rm -rf /`) or behind
    // a subshell (`$(rm -rf /)`) still requires approval.
    const heads = extractCommandHeads(intent.command)
    const dangerous = heads.find((head) => DANGEROUS_BASH_COMMANDS.has(head))
    if (dangerous || /`|\$\(/.test(intent.command)) {
      return {
        decision: 'ask',
        reason: `${dangerous ?? (intent.baseCommand || 'command')} requires approval in ask mode`,
        intent,
      }
    }
  }

  if (policy.mode === 'explore') {
    const layeredAllow = findLayeredAllow(policy, intent)
    const readOnly = isReadOnlyBashCommand(intent.command)
    if (!readOnly) {
      const hint = findBlockedCommandHint(policy, intent)
      return {
        decision: 'deny',
        reason: `Bash command is blocked in explore mode: ${intent.baseCommand || 'unknown command'}`,
        intent,
        hint: hint?.reason,
        matchedRule: hint?.match,
        ...(hint?.tryInstead?.length ? { tryInstead: hint.tryInstead } : {}),
        ...(hint?.context ? { hintContext: hint.context } : {}),
      }
    }
    if (layeredAllow) {
      return { decision: 'allow', intent, matchedRule: layeredAllow }
    }
  }

  return { decision: 'allow', intent }
}

function normalizeToolIntent(request: ToolPolicyRequest): ToolIntent {
  if (request.toolIntent) return request.toolIntent

  if (request.toolName === 'Bash') {
    const command = String(request.input?.command ?? '')
    // Strip leading env-assignments + directory prefix so `FOO=1 /bin/rm` reports
    // `rm`, not `FOO=1`, for both the danger check and the explanation text.
    const baseCommand = extractCommandHeads(command)[0] ?? ''
    return { kind: 'bash', command, baseCommand }
  }

  if (FILE_WRITE_TOOLS.has(request.toolName)) {
    return {
      kind: 'file_write',
      toolName: request.toolName,
      path: String(request.input?.file_path ?? request.input?.path ?? ''),
    }
  }

  if (request.toolName === 'MCP') {
    return {
      kind: 'mcp',
      name: String(request.input?.name ?? request.input?.toolName ?? request.input?.tool ?? ''),
    }
  }

  if (request.toolName === 'API') {
    const url = request.input?.url ? String(request.input.url) : undefined
    return {
      kind: 'api',
      method: String(request.input?.method ?? 'GET').toUpperCase(),
      path: pathFromUrl(url ?? String(request.input?.path ?? '/')),
      url,
    }
  }

  return { kind: 'unknown', toolName: request.toolName }
}

function findLayeredAllow(
  policy: PermissionPolicy,
  intent: ToolIntent,
  scope?: PermissionScopeInput,
): PolicyRuleMatch | undefined {
  for (const layer of policy.layers) {
    if (layer.scope && scopeKey(layer.scope) !== scopeKey(scope)) continue

    const match = matchLayerRules(layer, intent)
    if (match) return match
  }
  return undefined
}

function matchLayerRules(layer: PolicyLayer, intent: ToolIntent): PolicyRuleMatch | undefined {
  if (intent.kind === 'file_write') {
    // Never let a traversal path satisfy an allow-prefix (see hasPathTraversal).
    if (hasPathTraversal(intent.path)) return undefined
    const pattern = layer.rules.allowedWritePaths?.find(rule => globMatches(rule, intent.path))
    return pattern ? { layerId: layer.id, ruleType: 'write-path', pattern } : undefined
  }

  if (intent.kind === 'mcp') {
    const pattern = layer.rules.allowedMcpPatterns?.find(rule => regexMatches(rule, intent.name))
    return pattern ? { layerId: layer.id, ruleType: 'mcp-pattern', pattern } : undefined
  }

  if (intent.kind === 'api') {
    const rule = layer.rules.allowedApiEndpoints?.find(candidate => (
      candidate.method.toUpperCase() === intent.method && globMatches(candidate.pattern, intent.path)
    ))
    return rule ? { layerId: layer.id, ruleType: 'api-endpoint', pattern: `${rule.method.toUpperCase()} ${rule.pattern}` } : undefined
  }

  if (intent.kind === 'bash') {
    const pattern = layer.rules.allowedBashPatterns?.find(rule => regexMatches(rule, intent.command))
    return pattern ? { layerId: layer.id, ruleType: 'bash-pattern', pattern } : undefined
  }

  return undefined
}

export interface BlockedCommandHintResult {
  reason: string
  match: PolicyRuleMatch
  tryInstead?: string[]
  context?: string
}

function findBlockedCommandHint(
  policy: PermissionPolicy,
  intent: Extract<ToolIntent, { kind: 'bash' }>,
): BlockedCommandHintResult | undefined {
  for (const layer of policy.layers) {
    const hint = layer.rules.blockedCommandHints?.find(rule => {
      if (rule.command !== intent.baseCommand) return false
      if (!rule.whenNotMatching) return true
      return !regexMatches(rule.whenNotMatching, intent.command)
    })
    if (hint) {
      return {
        reason: hint.reason,
        match: {
          layerId: layer.id,
          ruleType: 'blocked-command-hint',
          pattern: hint.command,
        },
        ...(hint.tryInstead?.length ? { tryInstead: hint.tryInstead } : {}),
        ...(hint.context ? { context: hint.context } : {}),
      }
    }
  }
  return undefined
}

function pathFromUrl(value: string): string {
  try {
    return new URL(value).pathname
  } catch {
    return value.startsWith('/') ? value : `/${value}`
  }
}

function regexMatches(pattern: string, value: string): boolean {
  try {
    return new RegExp(pattern).test(value)
  } catch {
    return pattern === value
  }
}

function scopeMcpPatternToSource(sourceSlug: string, pattern: string): string {
  if (pattern.includes('mcp__')) return pattern
  return `^mcp__${escapeRegex(sourceSlug)}__.*${pattern}`
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function validateRuleSet(
  rulesValue: unknown,
  path: string,
  errors: PolicyConfigIssue[],
): void {
  if (rulesValue === undefined) {
    errors.push({
      path,
      message: 'Layer rules are required',
    })
    return
  }

  const rules = asRecord(rulesValue)
  validateRegexList(rules.allowedBashPatterns, `${path}.allowedBashPatterns`, errors)
  validateRegexList(rules.allowedMcpPatterns, `${path}.allowedMcpPatterns`, errors)
  validateApiEndpointRules(rules.allowedApiEndpoints, `${path}.allowedApiEndpoints`, errors)
}

function validateRegexList(
  value: unknown,
  path: string,
  errors: PolicyConfigIssue[],
): void {
  if (value === undefined) return
  if (!Array.isArray(value)) {
    errors.push({ path, message: 'Expected an array of regular expression strings' })
    return
  }

  value.forEach((pattern, index) => {
    if (typeof pattern !== 'string') {
      errors.push({ path: `${path}[${index}]`, message: 'Expected a regular expression string' })
      return
    }
    if (!isValidRegex(pattern)) {
      errors.push({
        path: `${path}[${index}]`,
        message: `Invalid regular expression: ${pattern}`,
      })
    }
  })
}

function validateApiEndpointRules(
  value: unknown,
  path: string,
  errors: PolicyConfigIssue[],
): void {
  if (value === undefined) return
  if (!Array.isArray(value)) {
    errors.push({ path, message: 'Expected an array of API endpoint rules' })
    return
  }

  value.forEach((ruleValue, index) => {
    const rule = asRecord(ruleValue)
    const method = rule.method
    if (typeof method !== 'string' || !HTTP_METHODS.has(method.toUpperCase())) {
      errors.push({
        path: `${path}[${index}].method`,
        message: `Invalid HTTP method: ${String(method)}`,
        suggestion: 'Use one of: GET, POST, PUT, PATCH, DELETE',
      })
    }
    if (typeof rule.pattern !== 'string') {
      errors.push({
        path: `${path}[${index}].pattern`,
        message: 'API endpoint pattern is required',
      })
    }
  })
}

const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {}
}

// Node.js-only modules are exported via sub-path './loader' and './merge'
// to keep the root entry browser-safe (no node:fs/path/os imports).
