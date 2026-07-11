import { describe, expect, test } from 'vitest'

import { createAutomationsConfigDoctorReport } from '@weft/automations'
import {
  createConfigRecoveryReceipt,
  createConfigWatchEvent,
  createResourceBundleSnapshot,
  createToolRegistryVersion,
  validateStatusConfig,
} from '@weft/host-services'
import { validateSkillDefinitionContent } from '@weft/skills'
import { validateSourceConfig } from '@weft/sources'

describe('Config governance — source validator', () => {
  test('returns machine-readable errors for malformed source configs', () => {
    const result = validateSourceConfig({
      id: 'linear',
      name: 'Linear',
      slug: 'linear',
      enabled: true,
      provider: 'linear',
      type: 'mcp',
      mcp: {
        transport: 'stdio',
      },
    })

    expect(result.valid).toBe(false)
    expect(result.errors).toEqual([
      {
        file: 'sources/linear/config.json',
        path: 'mcp.command',
        message: 'Stdio MCP sources require a command',
        severity: 'error',
        suggestion: 'Set mcp.command to the executable used to start the MCP server.',
      },
    ])
  })

  test('warns when static source config appears to contain credential values', () => {
    const result = validateSourceConfig({
      id: 'github',
      name: 'GitHub',
      slug: 'github',
      enabled: true,
      provider: 'github',
      type: 'api',
      api: {
        baseUrl: 'https://api.github.com',
        authType: 'bearer',
        defaultHeaders: {
          Authorization: 'Bearer secret-value',
          Accept: 'application/json',
        },
      },
    })

    expect(result.valid).toBe(true)
    expect(result.warnings).toEqual([
      {
        file: 'sources/github/config.json',
        path: 'api.defaultHeaders.Authorization',
        message: 'Source config should not store credential-bearing headers',
        severity: 'warning',
        suggestion: 'Store secret values in the source credential gateway and keep only credentialRef metadata in runtime descriptors.',
      },
    ])
  })
})

describe('Config governance — automation doctor', () => {
  test('summarizes automation config diagnostics and counts', () => {
    const report = createAutomationsConfigDoctorReport(JSON.stringify({
      automations: {
        TodoStateChange: [
          {
            id: 'auto-1',
            permissionMode: 'ask',
            actions: [{ type: 'prompt', prompt: 'Summarize status' }],
          },
        ],
      },
    }), 'automations.json')

    expect(report.domain).toBe('automations')
    expect(report.valid).toBe(true)
    expect(report.summary).toEqual({
      matcherCount: 1,
      actionCount: 1,
    })
    expect(report.warnings.map(warning => warning.path)).toEqual([
      'automations.TodoStateChange',
    ])
  })

  test('rejects permissionMode "auto" as a validation error', () => {
    const report = createAutomationsConfigDoctorReport(JSON.stringify({
      automations: {
        SessionStatusChange: [
          {
            id: 'auto-1',
            permissionMode: 'auto',
            actions: [{ type: 'prompt', prompt: 'Summarize status' }],
          },
        ],
      },
    }), 'automations.json')

    expect(report.valid).toBe(false)
    expect(report.errors.some(error =>
      error.path.includes('permissionMode') && error.message.includes('is not permitted')
    )).toBe(true)
  })

  test('does not write diagnostics to console during validation', () => {
    const originalWarn = console.warn
    const warnings: unknown[][] = []
    console.warn = (...args: unknown[]) => {
      warnings.push(args)
    }
    try {
      createAutomationsConfigDoctorReport(JSON.stringify({
        automations: {
          TodoStateChange: [
            {
              id: 'auto-1',
              actions: [{ type: 'prompt', prompt: 'Summarize status' }],
            },
          ],
        },
      }), 'automations.json')
    } finally {
      console.warn = originalWarn
    }

    expect(warnings).toEqual([])
  })
})

describe('Config governance — skill validator', () => {
  test('returns machine-readable errors for malformed SKILL.md metadata', () => {
    const result = validateSkillDefinitionContent(`---
description: Missing name
alwaysAllow:
  - Bash
  - 12
---

Review the current diff.
`, 'skills/review/SKILL.md')

    expect(result.valid).toBe(false)
    expect(result.errors).toEqual([
      {
        file: 'skills/review/SKILL.md',
        path: 'frontmatter.name',
        message: 'Skill metadata requires name',
        severity: 'error',
      },
      {
        file: 'skills/review/SKILL.md',
        path: 'frontmatter.alwaysAllow[1]',
        message: 'alwaysAllow entries must be strings',
        severity: 'error',
      },
    ])
  })

  test('warns when a skill has no trigger metadata', () => {
    const result = validateSkillDefinitionContent(`---
name: Review
description: Review changed code
---

Review the current diff.
`, 'skills/review/SKILL.md')

    expect(result.valid).toBe(true)
    expect(result.warnings).toEqual([
      {
        file: 'skills/review/SKILL.md',
        path: 'frontmatter',
        message: 'Skill has no activation metadata',
        severity: 'warning',
        suggestion: 'Add globs, requiredSources, or select the skill explicitly from the host UI.',
      },
    ])
  })
})

describe('Config governance — host recovery and registry contracts', () => {
  test('creates explicit config recovery receipts without silently overwriting user config', () => {
    const receipt = createConfigRecoveryReceipt({
      configPath: 'automations.json',
      configKind: 'automation',
      problem: 'malformed_json',
      recovery: 'fallback_to_default',
      defaultVersion: '2026-05-16',
      userConfigHash: 'bad-user-hash',
      migratedAliases: ['permissionMode:always_allow->allow-all'],
      matcherIdsBackfilled: ['auto-1'],
    })

    expect(receipt).toMatchObject({
      configPath: 'automations.json',
      configKind: 'automation',
      problem: 'malformed_json',
      recovery: 'fallback_to_default',
      userConfigHash: 'bad-user-hash',
      defaultVersion: '2026-05-16',
      overwroteUserConfig: false,
      migratedAliases: ['permissionMode:always_allow->allow-all'],
      matcherIdsBackfilled: ['auto-1'],
    })
    expect(receipt.receiptId).toMatch(/^config-recovery:/)
  })

  test('resource bundle snapshots and config watch events are deterministic and auditable', () => {
    const snapshot = createResourceBundleSnapshot({
      workspaceId: 'workspace-a',
      resources: [
        { path: 'sources/github/config.json', kind: 'source', contentHash: 'hash-source', version: '1' },
        { path: 'skills/review/SKILL.md', kind: 'skill', contentHash: 'hash-skill', version: '2' },
      ],
    })

    const watchEvent = createConfigWatchEvent({
      workspaceId: 'workspace-a',
      configPath: 'sources/github/config.json',
      configKind: 'source',
      action: 'updated',
      source: 'file_watcher',
      timestamp: 6_000,
      previousHash: 'old-hash',
      nextHash: 'hash-source',
    })

    expect(snapshot).toMatchObject({
      workspaceId: 'workspace-a',
      resourceCount: 2,
      resources: [
        { path: 'skills/review/SKILL.md', kind: 'skill', contentHash: 'hash-skill', version: '2' },
        { path: 'sources/github/config.json', kind: 'source', contentHash: 'hash-source', version: '1' },
      ],
    })
    expect(snapshot.snapshotId).toMatch(/^resource-bundle:/)
    expect(watchEvent).toMatchObject({
      workspaceId: 'workspace-a',
      configPath: 'sources/github/config.json',
      configKind: 'source',
      action: 'updated',
      source: 'file_watcher',
      timestamp: 6_000,
      previousHash: 'old-hash',
      nextHash: 'hash-source',
    })
    expect(watchEvent.eventId).toMatch(/^config-watch:/)
  })

  test('tool registry versions expose runtime support matrix and degraded capabilities', () => {
    const registry = createToolRegistryVersion({
      registryVersion: '2026-05-16',
      tools: [
        {
          name: 'runBrowserAction',
          category: 'browser',
          schemaVersion: '1',
          featureFlags: ['host-callback'],
          runtimeSupport: {
            claude: 'supported',
            codex: 'supported',
            mcp: 'degraded',
            cli: 'unsupported',
          },
        },
        {
          name: 'queryLlm',
          category: 'secondary_llm',
          schemaVersion: '1',
          safeMode: true,
          runtimeSupport: {
            claude: 'degraded',
            codex: 'degraded',
            mcp: 'unsupported',
            cli: 'unsupported',
          },
        },
      ],
    })

    expect(registry.toolCount).toBe(2)
    expect(registry.tools.map(tool => tool.name)).toEqual(['queryLlm', 'runBrowserAction'])
    expect(registry.unsupported).toEqual([
      { name: 'queryLlm', runtimeKind: 'cli' },
      { name: 'queryLlm', runtimeKind: 'mcp' },
      { name: 'runBrowserAction', runtimeKind: 'cli' },
    ])
    expect(registry.degraded).toEqual([
      { name: 'queryLlm', runtimeKind: 'claude' },
      { name: 'queryLlm', runtimeKind: 'codex' },
      { name: 'runBrowserAction', runtimeKind: 'mcp' },
    ])
  })

  test('status config validation rejects duplicate and terminal-start states', () => {
    const result = validateStatusConfig({
      statuses: [
        { id: 'active', label: 'Active', terminal: true },
        { id: 'active', label: 'Duplicate' },
        { id: 'done', label: 'Done', terminal: true },
      ],
      initialStatus: 'active',
      allowedTransitions: [
        { from: 'active', to: 'missing' },
      ],
    }, 'statuses.json')

    expect(result.valid).toBe(false)
    expect(result.errors).toEqual([
      {
        file: 'statuses.json',
        path: 'statuses[1].id',
        message: 'Status id must be unique',
        severity: 'error',
      },
      {
        file: 'statuses.json',
        path: 'initialStatus',
        message: 'Initial status cannot be terminal',
        severity: 'error',
      },
      {
        file: 'statuses.json',
        path: 'allowedTransitions[0].to',
        message: 'Transition target status is not defined',
        severity: 'error',
      },
    ])
  })
})
