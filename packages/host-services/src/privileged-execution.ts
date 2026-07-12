import { createHash } from 'node:crypto'

export interface PrivilegedExecutionAuditEvent {
  event:
    | 'privileged_request_created'
    | 'privileged_request_hash_mismatch'
    | 'privileged_request_blocked_by_policy'
    | 'privileged_request_expired'
    | 'privileged_request_approved'
    | 'privileged_request_denied'
  requestId: string
  sessionId?: string
  commandHash?: string
  policyAllowed?: boolean
  policyReason?: string
  timestamp: number
}

export interface PrivilegedExecutionRequestInput {
  requestId: string
  sessionId: string
  command: string
  reason?: string
  impact?: string
  approvalTtlMs?: number
}

export interface PrivilegedExecutionRequest {
  requestId: string
  sessionId: string
  command: string
  commandHash: string
  reason?: string
  impact?: string
  approvalTtlMs: number
  createdAt: number
  expiresAt: number
  policyAllowed: boolean
  policyReason?: string
}

export interface PrivilegedExecutionResolveOptions {
  expectedCommandHash?: string
  now?: number
}

export type PrivilegedExecutionResolveResult =
  | { ok: true; request: PrivilegedExecutionRequest }
  | { ok: false; reason: 'not_found' | 'command_hash_mismatch' | 'blocked_by_policy' | 'expired' }

export interface PrivilegedExecutionBrokerOptions {
  now?: () => number
  audit?: (event: PrivilegedExecutionAuditEvent) => void
  approvalTtlMs?: number
}

export interface PrivilegedExecutionBroker {
  createRequest(input: PrivilegedExecutionRequestInput): PrivilegedExecutionRequest
  resolveApproval(
    requestId: string,
    approved: boolean,
    options?: PrivilegedExecutionResolveOptions,
  ): PrivilegedExecutionResolveResult
}

const DEFAULT_APPROVAL_TTL_MS = 120_000

export function createPrivilegedExecutionBroker(
  options: PrivilegedExecutionBrokerOptions = {},
): PrivilegedExecutionBroker {
  const pending = new Map<string, PrivilegedExecutionRequest>()
  const now = options.now ?? Date.now
  const audit = options.audit ?? (() => undefined)

  function auditEvent(event: Omit<PrivilegedExecutionAuditEvent, 'timestamp'>, timestamp = now()): void {
    audit({ ...event, timestamp })
  }

  return {
    createRequest(input) {
      const timestamp = now()
      const approvalTtlMs = input.approvalTtlMs ?? options.approvalTtlMs ?? DEFAULT_APPROVAL_TTL_MS
      const policy = validatePrivilegedCommand(input.command)
      const request: PrivilegedExecutionRequest = {
        requestId: input.requestId,
        sessionId: input.sessionId,
        command: input.command,
        commandHash: hashCommand(input.command),
        reason: input.reason,
        impact: input.impact,
        approvalTtlMs,
        createdAt: timestamp,
        expiresAt: timestamp + approvalTtlMs,
        policyAllowed: policy.allowed,
        policyReason: policy.reason,
      }
      pending.set(input.requestId, request)
      auditEvent({
        event: 'privileged_request_created',
        requestId: request.requestId,
        sessionId: request.sessionId,
        commandHash: request.commandHash,
        policyAllowed: request.policyAllowed,
        policyReason: request.policyReason,
      }, timestamp)
      return request
    },

    resolveApproval(requestId, approved, resolveOptions = {}) {
      const timestamp = resolveOptions.now ?? now()
      const request = pending.get(requestId)
      if (!request) return { ok: false, reason: 'not_found' }
      pending.delete(requestId)

      if (
        resolveOptions.expectedCommandHash &&
        resolveOptions.expectedCommandHash !== request.commandHash
      ) {
        auditEvent({
          event: 'privileged_request_hash_mismatch',
          requestId: request.requestId,
          sessionId: request.sessionId,
          commandHash: request.commandHash,
        }, timestamp)
        return { ok: false, reason: 'command_hash_mismatch' }
      }

      if (!request.policyAllowed) {
        auditEvent({
          event: 'privileged_request_blocked_by_policy',
          requestId: request.requestId,
          sessionId: request.sessionId,
          commandHash: request.commandHash,
          policyAllowed: false,
          policyReason: request.policyReason,
        }, timestamp)
        return { ok: false, reason: 'blocked_by_policy' }
      }

      if (timestamp > request.expiresAt) {
        auditEvent({
          event: 'privileged_request_expired',
          requestId: request.requestId,
          sessionId: request.sessionId,
          commandHash: request.commandHash,
        }, timestamp)
        return { ok: false, reason: 'expired' }
      }

      auditEvent({
        event: approved ? 'privileged_request_approved' : 'privileged_request_denied',
        requestId: request.requestId,
        sessionId: request.sessionId,
        commandHash: request.commandHash,
      }, timestamp)

      return approved ? { ok: true, request } : { ok: false, reason: 'blocked_by_policy' }
    },
  }
}

function hashCommand(command: string): string {
  return createHash('sha256').update(command, 'utf8').digest('hex')
}

// Shell metacharacters that enable command chaining, substitution, or
// redirection. The allowlist below validates a single command invocation, so a
// command carrying any of these can smuggle a second (unvalidated) command past
// the check — reject before pattern-matching.
const SHELL_METACHARACTERS = /[;&|`$(){}<>\n\r\\!*?~"']/

function validatePrivilegedCommand(command: string): { allowed: boolean; reason?: string } {
  const normalized = command.trim().toLowerCase()

  // The allow patterns are anchored end-to-end ($) so nothing can follow the
  // matched invocation; the metacharacter guard is defense in depth against a
  // token like `--cask foo;rm -rf /` that would otherwise be a single \S+ run.
  const allowed =
    !SHELL_METACHARACTERS.test(normalized) &&
    (/^brew\s+install\s+--cask\s+\S+$/.test(normalized) ||
      /^brew\s+upgrade\s+--cask\s+\S+$/.test(normalized) ||
      /^installer\s+-pkg\s+\S+\s+-target\s+\/\S*$/.test(normalized))

  return allowed
    ? { allowed: true }
    : {
        allowed: false,
        reason: 'Privileged execution policy only allows brew cask install/upgrade and installer -pkg -target / commands',
      }
}
