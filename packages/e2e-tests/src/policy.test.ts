import { describe, expect, test } from 'vitest'

import {
  createInMemoryApprovalStore,
  createPermissionPolicy,
  createPermissionPolicyFromConfig,
  createPolicyDecisionReceipt,
  createSourcePolicyLayer,
  evaluateToolPolicy,
  explainToolPolicy,
  validatePolicyConfig,
  type PermissionPolicy,
} from '@weft/policy'

describe('Policy — provider-neutral permission evaluation', () => {
  test('explore mode denies file write tools', () => {
    const policy = createPermissionPolicy({ mode: 'explore' })

    const decision = evaluateToolPolicy(policy, {
      toolName: 'Write',
      input: { file_path: 'src/index.ts' },
    })

    expect(decision).toEqual({
      decision: 'deny',
      reason: 'Write is blocked in explore mode',
    })
  })

  test('explore mode allows read-only bash commands', () => {
    const policy = createPermissionPolicy({ mode: 'explore' })

    const decision = evaluateToolPolicy(policy, {
      toolName: 'Bash',
      input: { command: 'git status --short' },
    })

    expect(decision).toEqual({ decision: 'allow' })
  })

  test('ask mode requests approval for dangerous bash commands', () => {
    const policy = createPermissionPolicy({ mode: 'ask' })

    const decision = evaluateToolPolicy(policy, {
      toolName: 'Bash',
      input: { command: 'rm -rf dist' },
    })

    expect(decision).toEqual({
      decision: 'ask',
      reason: 'rm requires approval in ask mode',
    })
  })

  test('scoped always-allow grants only matching tool and scope', () => {
    const policy: PermissionPolicy = createPermissionPolicy({
      mode: 'explore',
      alwaysAllow: [
        { toolName: 'Write', scope: 'skill:commit-helper' },
      ],
    })

    expect(evaluateToolPolicy(policy, {
      toolName: 'Write',
      input: { file_path: 'CHANGELOG.md' },
      scope: 'skill:commit-helper',
    })).toEqual({ decision: 'allow' })

    expect(evaluateToolPolicy(policy, {
      toolName: 'Write',
      input: { file_path: 'CHANGELOG.md' },
      scope: 'skill:other',
    })).toEqual({
      decision: 'deny',
      reason: 'Write is blocked in explore mode',
    })
  })

  test('session-scoped approval grants only matching tool, scope, and unexpired time window', () => {
    let now = 1_000
    const store = createInMemoryApprovalStore({ now: () => now })

    store.remember({
      id: 'approval-1',
      toolName: 'Write',
      scope: { type: 'session', sessionId: 'session-a' },
      origin: { type: 'user', id: 'user-approval' },
      expiresAt: 2_000,
    })

    const policy = createPermissionPolicy({
      mode: 'explore',
      approvals: store.snapshot(),
    })

    expect(evaluateToolPolicy(policy, {
      toolName: 'Write',
      input: { file_path: 'CHANGELOG.md' },
      scope: { type: 'session', sessionId: 'session-a' },
    })).toEqual({ decision: 'allow' })

    expect(evaluateToolPolicy(policy, {
      toolName: 'Write',
      input: { file_path: 'CHANGELOG.md' },
      scope: { type: 'session', sessionId: 'session-b' },
    })).toEqual({
      decision: 'deny',
      reason: 'Write is blocked in explore mode',
    })

    now = 2_001
    expect(evaluateToolPolicy(createPermissionPolicy({
      mode: 'explore',
      approvals: store.snapshot(),
    }), {
      toolName: 'Write',
      input: { file_path: 'CHANGELOG.md' },
      scope: { type: 'session', sessionId: 'session-a' },
    })).toEqual({
      decision: 'deny',
      reason: 'Write is blocked in explore mode',
    })
  })

  test('layered policy allows scoped write paths and explains the matched rule', () => {
    const policy = createPermissionPolicy({
      mode: 'explore',
      layers: [
        {
          id: 'workspace-default',
          rules: {
            allowedWritePaths: ['docs/**'],
          },
        },
      ],
    })

    const allowed = explainToolPolicy(policy, {
      toolName: 'Write',
      input: { file_path: 'docs/ARCHITECTURE.md' },
    })

    expect(allowed.decision).toBe('allow')
    expect(allowed.intent.kind).toBe('file_write')
    expect(allowed.matchedRule).toEqual({
      layerId: 'workspace-default',
      ruleType: 'write-path',
      pattern: 'docs/**',
    })

    expect(evaluateToolPolicy(policy, {
      toolName: 'Write',
      input: { file_path: 'src/index.ts' },
    })).toEqual({
      decision: 'deny',
      reason: 'Write is blocked in explore mode',
    })
  })

  test('layered policy allows API and MCP tool intents without broad safe-mode access', () => {
    const policy = createPermissionPolicy({
      mode: 'explore',
      layers: [
        {
          id: 'source-github',
          rules: {
            allowedApiEndpoints: [
              { method: 'GET', pattern: '/repos/**' },
            ],
          },
        },
        {
          id: 'source-linear',
          rules: {
            allowedMcpPatterns: ['^linear:read_.*$'],
          },
        },
      ],
    })

    expect(evaluateToolPolicy(policy, {
      toolName: 'API',
      input: { method: 'GET', url: 'https://api.github.com/repos/owner/repo/issues' },
    })).toEqual({ decision: 'allow' })

    expect(evaluateToolPolicy(policy, {
      toolName: 'API',
      input: { method: 'POST', url: 'https://api.github.com/repos/owner/repo/issues' },
    })).toEqual({
      decision: 'deny',
      reason: 'API endpoint is blocked in explore mode: POST /repos/owner/repo/issues',
    })

    expect(evaluateToolPolicy(policy, {
      toolName: 'MCP',
      input: { name: 'linear:read_issue' },
    })).toEqual({ decision: 'allow' })

    expect(evaluateToolPolicy(policy, {
      toolName: 'MCP',
      input: { name: 'linear:update_issue' },
    })).toEqual({
      decision: 'deny',
      reason: 'MCP tool is blocked in explore mode: linear:update_issue',
    })
  })

  test('uses provider-normalized tool intent when present', () => {
    const policy = createPermissionPolicy({ mode: 'ask' })

    expect(evaluateToolPolicy(policy, {
      toolName: 'commandExecution',
      input: { command: 'rm -rf dist' },
      toolIntent: {
        kind: 'bash',
        command: 'rm -rf dist',
        baseCommand: 'rm',
      },
    })).toEqual({
      decision: 'ask',
      reason: 'rm requires approval in ask mode',
    })
  })

  test('blocked command hints are included in policy explanations', () => {
    const policy = createPermissionPolicy({
      mode: 'explore',
      layers: [
        {
          id: 'app-default',
          rules: {
            blockedCommandHints: [
              {
                command: 'rm',
                reason: 'Use git clean preview or ask for approval before deleting files.',
              },
            ],
          },
        },
      ],
    })

    const explanation = explainToolPolicy(policy, {
      toolName: 'Bash',
      input: { command: 'rm -rf dist' },
    })

    expect(explanation).toMatchObject({
      decision: 'deny',
      hint: 'Use git clean preview or ask for approval before deleting files.',
      matchedRule: {
        layerId: 'app-default',
        ruleType: 'blocked-command-hint',
        pattern: 'rm',
      },
    })
  })

  test('creates machine-readable policy decision receipts with explain metadata', () => {
    const policy = createPermissionPolicy({
      mode: 'explore',
      layers: [
        {
          id: 'app-default',
          rules: {
            blockedCommandHints: [
              {
                command: 'rm',
                reason: 'Use git clean preview or ask for approval before deleting files.',
              },
            ],
          },
        },
      ],
    })

    const receipt = createPolicyDecisionReceipt({
      requestId: 'policy-request-1',
      policy,
      request: {
        toolName: 'Bash',
        input: { command: 'rm -rf dist' },
      },
      origin: { type: 'automation', id: 'cleanup' },
      timelineRefs: [{ epoch: 'epoch-a', seq: 7 }],
    })

    expect(receipt).toMatchObject({
      requestId: 'policy-request-1',
      decision: {
        decision: 'deny',
        reason: 'Bash command is blocked in explore mode: rm',
      },
      explain: {
        decision: 'deny',
        reason: 'Bash command is blocked in explore mode: rm',
        intent: {
          kind: 'bash',
          command: 'rm -rf dist',
          baseCommand: 'rm',
        },
      },
      intent: {
        kind: 'bash',
        command: 'rm -rf dist',
        baseCommand: 'rm',
      },
      matchedRule: {
        layerId: 'app-default',
        ruleType: 'blocked-command-hint',
        pattern: 'rm',
      },
      hint: 'Use git clean preview or ask for approval before deleting files.',
      origin: { type: 'automation', id: 'cleanup' },
      timelineRefs: [{ epoch: 'epoch-a', seq: 7 }],
    })
  })

  test('source policy layers auto-scope simple MCP patterns to the source slug', () => {
    const policy = createPermissionPolicy({
      mode: 'explore',
      layers: [
        createSourcePolicyLayer({
          sourceSlug: 'github',
          rules: {
            allowedMcpPatterns: ['list'],
          },
        }),
      ],
    })

    expect(evaluateToolPolicy(policy, {
      toolName: 'MCP',
      input: { name: 'mcp__github__issues_list' },
    })).toEqual({ decision: 'allow' })

    expect(evaluateToolPolicy(policy, {
      toolName: 'MCP',
      input: { name: 'mcp__linear__issues_list' },
    })).toEqual({
      decision: 'deny',
      reason: 'MCP tool is blocked in explore mode: mcp__linear__issues_list',
    })
  })

  test('policy config validation returns machine-readable diagnostics', () => {
    const validation = validatePolicyConfig({
      mode: 'bogus',
      layers: [
        {
          id: 'bad-regex',
          rules: {
            allowedBashPatterns: ['['],
            allowedApiEndpoints: [
              { method: 'FETCH', pattern: '/repos/**' },
            ],
          },
        },
      ],
    })

    expect(validation.valid).toBe(false)
    expect(validation.errors).toEqual([
      {
        path: 'mode',
        message: 'Invalid permission mode: bogus',
        suggestion: 'Use one of: explore, ask, auto',
      },
      {
        path: 'layers[0].rules.allowedBashPatterns[0]',
        message: 'Invalid regular expression: [',
      },
      {
        path: 'layers[0].rules.allowedApiEndpoints[0].method',
        message: 'Invalid HTTP method: FETCH',
        suggestion: 'Use one of: GET, POST, PUT, PATCH, DELETE',
      },
    ])
  })

  test('policy config loader compiles source-scoped layers into an executable policy', () => {
    const result = createPermissionPolicyFromConfig({
      mode: 'explore',
      layers: [
        {
          id: 'github-read',
          sourceSlug: 'github',
          rules: {
            allowedMcpPatterns: ['list'],
          },
        },
      ],
    })

    expect(result.validation.valid).toBe(true)
    expect(result.policy).toBeDefined()
    expect(evaluateToolPolicy(result.policy!, {
      toolName: 'MCP',
      input: { name: 'mcp__github__issues_list' },
    })).toEqual({ decision: 'allow' })
    expect(evaluateToolPolicy(result.policy!, {
      toolName: 'MCP',
      input: { name: 'mcp__linear__issues_list' },
    })).toEqual({
      decision: 'deny',
      reason: 'MCP tool is blocked in explore mode: mcp__linear__issues_list',
    })
  })
})

describe('B3 — policy ↔ runtime-core bridge', () => {
  test('createPolicyRuntimeHook satisfies RuntimePolicyHook structurally and evaluates the policy', async () => {
    const { createPermissionPolicy, createPolicyRuntimeHook } = await import('@weft/policy')
    const policy = createPermissionPolicy({
      mode: 'ask',
      layers: [{ id: 'test', rules: { allowedBashPatterns: ['^git status'] } }],
    })

    // Compile-time: the bridge is assignable to runtime-core's hook contract.
    const hook: import('@weft/runtime-core').RuntimePolicyHook = createPolicyRuntimeHook(policy)

    const allowed = await hook({
      toolName: 'Bash',
      input: { command: 'git status' },
      toolIntent: { kind: 'bash', command: 'git status', baseCommand: 'git' },
    })
    expect(allowed.decision).toBe('allow')

    const asked = await hook({
      toolName: 'Bash',
      input: { command: 'rm -rf /' },
      toolIntent: { kind: 'bash', command: 'rm -rf /', baseCommand: 'rm' },
    })
    expect(asked.decision).not.toBe('allow')
  })

  test('policy request/intent/scope types stay structural twins of runtime-core types', async () => {
    // Pure compile-time parity checks — if the two type families drift, this
    // file stops compiling (the review's B3 finding: divergent parallel type
    // systems with hand-maintained parity).
    type PolicyTypes = typeof import('@weft/policy')
    type Req = import('@weft/policy').ToolPolicyRequest
    type RtReq = import('@weft/runtime-core').ToolPolicyRequest
    type Intent = import('@weft/policy').ToolIntent
    type RtIntent = import('@weft/runtime-core').RuntimeToolIntent
    type AssertMutual<A, B> = A extends B ? (B extends A ? true : never) : never
    const reqParity: AssertMutual<Req, RtReq> = true
    const intentParity: AssertMutual<Intent, RtIntent> = true
    expect(reqParity && intentParity).toBe(true)
    // Decision: policy's 3-way union must remain a subset of runtime-core's.
    type Dec = import('@weft/policy').ToolPolicyDecision
    type RtDec = import('@weft/runtime-core').ToolPolicyDecision
    const decisionSubset: Dec extends RtDec ? true : never = true
    expect(decisionSubset).toBe(true)
    void (undefined as unknown as PolicyTypes)
  })
})
