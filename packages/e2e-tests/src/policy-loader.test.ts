import { describe, expect, test, beforeEach, afterEach } from 'vitest'
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  createPermissionPolicy,
  evaluateToolPolicy,
  explainToolPolicy,
  type PolicyRuleSet,
  type PolicyLayer,
} from '@weft/policy'
import { loadPolicyFile, loadPolicyLayers } from '@weft/policy/loader'
import { mergePolicyRuleSets, mergePolicyLayers } from '@weft/policy/merge'

const TEST_DIR = join(tmpdir(), `weft-policy-test-${Date.now()}`)

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true })
})

afterEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true })
})

function writeJson(name: string, data: unknown): string {
  const path = join(TEST_DIR, name)
  writeFileSync(path, JSON.stringify(data, null, 2))
  return path
}

describe('Policy File Loader', () => {
  test('returns empty rules for non-existent file', async () => {
    const result = await loadPolicyFile(join(TEST_DIR, 'nope.json'))
    expect(result.errors).toHaveLength(0)
    expect(result.rules).toEqual({})
  })

  test('loads valid permissions file', async () => {
    const path = writeJson('permissions.json', {
      allowedBashPatterns: ['^ls\\s', '^cat\\s'],
      allowedMcpPatterns: ['^read_file$'],
      allowedWritePaths: ['src/**'],
      allowedApiEndpoints: [{ method: 'GET', pathPattern: '/api/.*' }],
      blockedCommandHints: [
        {
          command: 'rm',
          reason: 'Destructive file removal',
          tryInstead: ['trash-put'],
          context: 'Use trash instead of permanent delete',
          whenNotMatching: '^rm\\s+-i',
        },
      ],
    })

    const result = await loadPolicyFile(path)
    expect(result.errors).toHaveLength(0)
    expect(result.rules.allowedBashPatterns).toEqual(['^ls\\s', '^cat\\s'])
    expect(result.rules.allowedMcpPatterns).toEqual(['^read_file$'])
    expect(result.rules.allowedWritePaths).toEqual(['src/**'])
    expect(result.rules.allowedApiEndpoints).toEqual([{ method: 'GET', pattern: '/api/.*' }])
    expect(result.rules.blockedCommandHints).toHaveLength(1)
    expect(result.rules.blockedCommandHints![0]!.tryInstead).toEqual(['trash-put'])
    expect(result.rules.blockedCommandHints![0]!.context).toBe('Use trash instead of permanent delete')
  })

  test('reports error for invalid JSON', async () => {
    const path = join(TEST_DIR, 'bad.json')
    writeFileSync(path, '{not json')
    const result = await loadPolicyFile(path)
    expect(result.errors.length).toBeGreaterThan(0)
    expect(result.errors[0]).toContain('Invalid JSON')
  })

  test('reports error for non-object JSON', async () => {
    const path = writeJson('array.json', [1, 2, 3])
    const result = await loadPolicyFile(path)
    expect(result.errors[0]).toContain('Expected JSON object')
  })

  test('filters out invalid regex patterns with error', async () => {
    const path = writeJson('bad-regex.json', {
      allowedBashPatterns: ['^ls\\s', '[invalid('],
    })
    const result = await loadPolicyFile(path)
    expect(result.rules.allowedBashPatterns).toEqual(['^ls\\s'])
    expect(result.errors.some(e => e.includes('Invalid regex'))).toBe(true)
  })

  test('rejects non-string entries in pattern arrays', async () => {
    const path = writeJson('mixed.json', {
      allowedBashPatterns: ['^ls\\s', 42, null],
    })
    const result = await loadPolicyFile(path)
    expect(result.rules.allowedBashPatterns).toEqual(['^ls\\s'])
    expect(result.errors.some(e => e.includes('Non-string entry'))).toBe(true)
  })

  test('validates API endpoint structure', async () => {
    const path = writeJson('api.json', {
      allowedApiEndpoints: [
        { method: 'GET', pathPattern: '/api/.*' },
        { method: 'POST' },
        'not-an-object',
      ],
    })
    const result = await loadPolicyFile(path)
    expect(result.rules.allowedApiEndpoints).toHaveLength(1)
    expect(result.errors.length).toBeGreaterThan(0)
  })
})

describe('Policy Layers Loader', () => {
  test('loads global and workspace layers', async () => {
    const globalPath = writeJson('global.json', {
      allowedBashPatterns: ['^ls\\s'],
    })
    const wsPath = writeJson('workspace.json', {
      allowedBashPatterns: ['^npm\\s'],
      allowedWritePaths: ['src/**'],
    })

    const { layers, errors } = await loadPolicyLayers({
      globalPath,
      workspacePath: wsPath,
    })
    expect(errors).toHaveLength(0)
    expect(layers).toHaveLength(2)
    expect(layers[0]!.id).toBe('file:global')
    expect(layers[1]!.id).toBe('file:workspace')
  })

  test('skips empty files', async () => {
    const globalPath = writeJson('empty.json', {})
    const { layers } = await loadPolicyLayers({ globalPath })
    expect(layers).toHaveLength(0)
  })

  test('skips missing workspace path', async () => {
    const globalPath = writeJson('global.json', {
      allowedBashPatterns: ['^ls\\s'],
    })
    const { layers } = await loadPolicyLayers({ globalPath })
    expect(layers).toHaveLength(1)
  })
})

describe('Policy Rule Set Merge', () => {
  test('concatenates and deduplicates patterns', () => {
    const a: PolicyRuleSet = {
      allowedBashPatterns: ['^ls\\s', '^cat\\s'],
      allowedMcpPatterns: ['^read_file$'],
    }
    const b: PolicyRuleSet = {
      allowedBashPatterns: ['^cat\\s', '^npm\\s'],
      allowedWritePaths: ['src/**'],
    }

    const merged = mergePolicyRuleSets(a, b)
    expect(merged.allowedBashPatterns).toEqual(['^ls\\s', '^cat\\s', '^npm\\s'])
    expect(merged.allowedMcpPatterns).toEqual(['^read_file$'])
    expect(merged.allowedWritePaths).toEqual(['src/**'])
  })

  test('last blocked command hint wins per command', () => {
    const a: PolicyRuleSet = {
      blockedCommandHints: [{ command: 'rm', reason: 'old reason' }],
    }
    const b: PolicyRuleSet = {
      blockedCommandHints: [{ command: 'rm', reason: 'new reason', tryInstead: ['trash-put'] }],
    }

    const merged = mergePolicyRuleSets(a, b)
    expect(merged.blockedCommandHints).toHaveLength(1)
    expect(merged.blockedCommandHints![0]!.reason).toBe('new reason')
    expect(merged.blockedCommandHints![0]!.tryInstead).toEqual(['trash-put'])
  })

  test('merges API endpoints by method+pattern key', () => {
    const a: PolicyRuleSet = {
      allowedApiEndpoints: [{ method: 'GET', pattern: '/api/.*' }],
    }
    const b: PolicyRuleSet = {
      allowedApiEndpoints: [
        { method: 'GET', pattern: '/api/.*' },
        { method: 'POST', pattern: '/api/submit' },
      ],
    }

    const merged = mergePolicyRuleSets(a, b)
    expect(merged.allowedApiEndpoints).toHaveLength(2)
  })
})

describe('Merge Policy Layers', () => {
  test('returns undefined for empty array', () => {
    expect(mergePolicyLayers([], 'merged')).toBeUndefined()
  })

  test('returns single layer with new id', () => {
    const layer: PolicyLayer = {
      id: 'file:global',
      rules: { allowedBashPatterns: ['^ls\\s'] },
    }
    const merged = mergePolicyLayers([layer], 'merged')
    expect(merged!.id).toBe('merged')
    expect(merged!.rules.allowedBashPatterns).toEqual(['^ls\\s'])
  })

  test('merges multiple layers', () => {
    const layers: PolicyLayer[] = [
      { id: 'file:global', rules: { allowedBashPatterns: ['^ls\\s'] } },
      { id: 'file:workspace', rules: { allowedBashPatterns: ['^npm\\s'], allowedWritePaths: ['src/**'] } },
    ]
    const merged = mergePolicyLayers(layers, 'file:merged')
    expect(merged!.rules.allowedBashPatterns).toEqual(['^ls\\s', '^npm\\s'])
    expect(merged!.rules.allowedWritePaths).toEqual(['src/**'])
  })
})

describe('Enhanced Blocked Command Hints in Policy Evaluation', () => {
  test('explainToolPolicy surfaces tryInstead and hintContext', () => {
    const policy = createPermissionPolicy({
      mode: 'explore',
      layers: [
        {
          id: 'file:global',
          rules: {
            blockedCommandHints: [
              {
                command: 'rm',
                reason: 'Destructive: permanently deletes files',
                tryInstead: ['trash-put', 'gio trash'],
                context: 'Use a trash utility for recoverable deletion',
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

    expect(explanation.decision).toBe('deny')
    expect(explanation.hint).toBe('Destructive: permanently deletes files')
    expect(explanation.tryInstead).toEqual(['trash-put', 'gio trash'])
    expect(explanation.hintContext).toBe('Use a trash utility for recoverable deletion')
  })

  test('whenNotMatching exempts matching commands from hint', () => {
    const policy = createPermissionPolicy({
      mode: 'explore',
      layers: [
        {
          id: 'hints',
          rules: {
            blockedCommandHints: [
              {
                command: 'rm',
                reason: 'Destructive',
                whenNotMatching: '^rm\\s+-i',
              },
            ],
          },
        },
      ],
    })

    const safeExplanation = explainToolPolicy(policy, {
      toolName: 'Bash',
      input: { command: 'rm -i file.txt' },
    })
    expect(safeExplanation.decision).toBe('deny')
    expect(safeExplanation.hint).toBeUndefined()

    const unsafeExplanation = explainToolPolicy(policy, {
      toolName: 'Bash',
      input: { command: 'rm -rf /' },
    })
    expect(unsafeExplanation.hint).toBe('Destructive')
  })

  test('file-loaded layers integrate with evaluateToolPolicy', async () => {
    const globalPath = writeJson('integration.json', {
      allowedBashPatterns: ['^git\\s+log'],
    })

    const { layers } = await loadPolicyLayers({ globalPath })
    const policy = createPermissionPolicy({
      mode: 'explore',
      layers,
    })

    const allowed = evaluateToolPolicy(policy, {
      toolName: 'Bash',
      input: { command: 'git log --oneline' },
    })
    expect(allowed.decision).toBe('allow')
  })
})
