/**
 * Tests for persisted automations `permissionMode` parsing.
 *
 * `AutomationMatcherSchema` normalizes `permissionMode` via `parsePermissionMode`
 * (in @weft/core) then validates against the explore/ask enum; explore/ask pass
 * through, 'auto' is rejected (it would bypass all security checks — see the
 * pre-OSS security review, C2), and unknown values (including the removed
 * legacy aliases safe/allow-all/execute/ask-to-edit) are rejected.
 */

import { describe, it, expect } from 'vitest'
import { AutomationMatcherSchema } from './schemas.ts'

const validActions = [{ type: 'prompt' as const, prompt: 'do the thing' }]

function parseMatcher(permissionMode: unknown) {
  return AutomationMatcherSchema.parse({
    matcher: 'test',
    actions: validActions,
    permissionMode,
  })
}

describe('AutomationMatcherSchema — permissionMode', () => {
  it('passes allowed modes through unchanged', () => {
    expect(parseMatcher('explore').permissionMode).toBe('explore')
    expect(parseMatcher('ask').permissionMode).toBe('ask')
  })

  it('rejects "auto" — automations must not bypass security checks', () => {
    expect(() => parseMatcher('auto')).toThrow(/is not permitted/)
    // Case-insensitive: parsePermissionMode normalizes before the enum check
    expect(() => parseMatcher('AUTO')).toThrow(/is not permitted/)
  })

  it('treats omitted permissionMode as optional (undefined)', () => {
    const parsed = AutomationMatcherSchema.parse({ actions: validActions })
    expect(parsed.permissionMode).toBeUndefined()
  })

  it('rejects unknown / legacy-alias permissionMode values', () => {
    // Legacy aliases (safe/allow-all/execute/ask-to-edit) were removed; they are
    // now rejected by the explore/ask/auto enum like any other unknown value.
    for (const mode of ['bogus', 'safe', 'allow-all', 'execute', 'ask-to-edit']) {
      expect(() => parseMatcher(mode)).toThrow()
    }
  })
})
