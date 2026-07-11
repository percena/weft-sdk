/**
 * Tests for automations config validation.
 *
 * Focus: permissionMode "auto" must be rejected as a validation ERROR
 * (config rejected), not just warned about — automations run unattended
 * and "auto" would bypass all security checks.
 */

import { describe, it, expect } from 'vitest'
import { validateAutomationsContent, validateAutomationsConfig } from './validation.ts'

function configJson(permissionMode?: string): string {
  return JSON.stringify({
    automations: {
      SessionStatusChange: [
        {
          id: 'auto-1',
          ...(permissionMode ? { permissionMode } : {}),
          actions: [{ type: 'prompt', prompt: 'Summarize status' }],
        },
      ],
    },
  })
}

describe('validateAutomationsContent — permissionMode', () => {
  it('rejects configs that declare permissionMode "auto"', () => {
    const result = validateAutomationsContent(configJson('auto'), 'automations.json')
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) =>
      e.path.includes('permissionMode') && e.message.includes('"auto" is not permitted')
    )).toBe(true)
  })

  it('accepts "explore" and "ask"', () => {
    for (const mode of ['explore', 'ask']) {
      const result = validateAutomationsContent(configJson(mode), 'automations.json')
      expect(result.valid, mode).toBe(true)
    }
  })

  it('accepts configs without a permissionMode', () => {
    expect(validateAutomationsContent(configJson(), 'automations.json').valid).toBe(true)
  })
})

describe('validateAutomationsConfig — permissionMode', () => {
  it('rejects object configs that declare permissionMode "auto"', () => {
    const result = validateAutomationsConfig(JSON.parse(configJson('auto')))
    expect(result.valid).toBe(false)
    expect(result.config).toBeNull()
    expect(result.errors.some((e) => e.includes('"auto" is not permitted'))).toBe(true)
  })
})
