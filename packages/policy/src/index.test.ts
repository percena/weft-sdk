/**
 * Tests for persisted permission config `mode` validation.
 *
 * `validatePolicyConfig` / `createPermissionPolicyFromConfig` normalize `mode`
 * via `parsePermissionMode` (in @weft/core). Canonical modes (explore/ask/auto,
 * case-insensitive) validate and propagate; unknown values — including the
 * removed legacy aliases safe/allow-all/execute/ask-to-edit — are rejected.
 */

import { describe, it, expect } from 'vitest'
import {
  validatePolicyConfig,
  createPermissionPolicyFromConfig,
  evaluateToolPolicy,
} from './index.ts'

describe('validatePolicyConfig — permission mode validation', () => {
  it('is case-insensitive (parsePermissionMode lowercases)', () => {
    const result = createPermissionPolicyFromConfig({ mode: 'Explore' })
    expect(result.validation.valid).toBe(true)
    expect(result.policy!.mode).toBe('explore')
  })

  it('accepts canonical modes unchanged', () => {
    for (const mode of ['explore', 'ask', 'auto'] as const) {
      const result = createPermissionPolicyFromConfig({ mode })
      expect(result.validation.valid).toBe(true)
      expect(result.policy!.mode).toBe(mode)
    }
  })

  it('rejects unknown / legacy-alias modes with the existing diagnostic', () => {
    // Legacy aliases (safe/allow-all/execute/ask-to-edit) were removed; they are
    // now rejected like any other unknown mode.
    for (const mode of ['bogus', 'safe', 'allow-all', 'execute', 'ask-to-edit']) {
      const validation = validatePolicyConfig({ mode })
      expect(validation.valid).toBe(false)
      expect(validation.errors).toContainEqual({
        path: 'mode',
        message: `Invalid permission mode: ${mode}`,
        suggestion: 'Use one of: explore, ask, auto',
      })
    }
  })

  it('rejects non-string modes', () => {
    const validation = validatePolicyConfig({ mode: 42 })
    expect(validation.valid).toBe(false)
    expect(validation.errors.some(e => e.path === 'mode')).toBe(true)
  })

  it('canonical explore mode denies writes', () => {
    const { policy } = createPermissionPolicyFromConfig({ mode: 'explore' })
    expect(policy!.mode).toBe('explore')

    const deny = evaluateToolPolicy(policy!, {
      toolName: 'Write',
      input: { file_path: '/tmp/x' },
    })
    expect(deny.decision).toBe('deny')
  })

  it('canonical auto mode auto-approves writes', () => {
    const { policy } = createPermissionPolicyFromConfig({ mode: 'auto' })
    expect(policy!.mode).toBe('auto')

    const decision = evaluateToolPolicy(policy!, {
      toolName: 'Write',
      input: { file_path: '/tmp/x' },
    })
    expect(decision.decision).toBe('allow')
  })
})
