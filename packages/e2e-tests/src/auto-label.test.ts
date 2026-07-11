import { describe, expect, test } from 'vitest'

import {
  evaluateAutoLabels,
  normalizeNumberValue,
  validateAutoLabelPattern,
  type AutoLabelConfig,
} from '@weft/automations'

describe('Auto-Label Evaluator', () => {
  test('matches a simple regex pattern', () => {
    const configs: AutoLabelConfig[] = [
      {
        labelId: 'bug',
        rules: [{ pattern: '\\b(bug|defect)\\b' }],
      },
    ]

    const matches = evaluateAutoLabels('Found a bug in the login flow', configs)
    expect(matches).toHaveLength(1)
    expect(matches[0]!.labelId).toBe('bug')
    expect(matches[0]!.value).toBe('bug')
  })

  test('uses capture group for value extraction', () => {
    const configs: AutoLabelConfig[] = [
      {
        labelId: 'priority',
        rules: [{ pattern: 'priority:\\s*(\\d+)', flags: 'gi' }],
      },
    ]

    const matches = evaluateAutoLabels('Set priority: 3 for this task', configs)
    expect(matches).toHaveLength(1)
    expect(matches[0]!.value).toBe('3')
  })

  test('uses valueTemplate with capture group substitution', () => {
    const configs: AutoLabelConfig[] = [
      {
        labelId: 'ticket',
        rules: [{ pattern: '(JIRA|GH)-(\\d+)', valueTemplate: '$1-$2' }],
      },
    ]

    const matches = evaluateAutoLabels('Fix for GH-123 and JIRA-456', configs)
    expect(matches).toHaveLength(2)
    expect(matches[0]!.value).toBe('GH-123')
    expect(matches[1]!.value).toBe('JIRA-456')
  })

  test('strips code blocks before evaluation', () => {
    const configs: AutoLabelConfig[] = [
      {
        labelId: 'bug',
        rules: [{ pattern: '\\bbug\\b' }],
      },
    ]

    const text = 'No bugs here\n```\nthis has bug keyword\n```'
    const matches = evaluateAutoLabels(text, configs)
    expect(matches).toHaveLength(0)
  })

  test('strips inline code before evaluation', () => {
    const configs: AutoLabelConfig[] = [
      {
        labelId: 'error',
        rules: [{ pattern: '\\berror\\b' }],
      },
    ]

    const text = 'Check `error` handling in the code'
    const matches = evaluateAutoLabels(text, configs)
    expect(matches).toHaveLength(0)
  })

  test('caps matches at 10 per message', () => {
    const configs: AutoLabelConfig[] = [
      {
        labelId: 'word',
        rules: [{ pattern: '(\\w+)' }],
      },
    ]

    const text = 'one two three four five six seven eight nine ten eleven twelve'
    const matches = evaluateAutoLabels(text, configs)
    expect(matches).toHaveLength(10)
  })

  test('deduplicates identical labelId+value pairs', () => {
    const configs: AutoLabelConfig[] = [
      {
        labelId: 'tag',
        rules: [{ pattern: '#(\\w+)' }],
      },
    ]

    const text = '#frontend #backend #frontend #frontend'
    const matches = evaluateAutoLabels(text, configs)
    expect(matches).toHaveLength(2)
  })

  test('enforces g flag to avoid infinite loops', () => {
    const configs: AutoLabelConfig[] = [
      {
        labelId: 'test',
        rules: [{ pattern: 'test', flags: 'i' }],
      },
    ]

    const matches = evaluateAutoLabels('test TEST Test', configs)
    expect(matches.length).toBeGreaterThanOrEqual(1)
  })

  test('skips invalid regex gracefully', () => {
    const configs: AutoLabelConfig[] = [
      {
        labelId: 'bad',
        rules: [{ pattern: '[invalid(' }],
      },
    ]

    const matches = evaluateAutoLabels('some text', configs)
    expect(matches).toHaveLength(0)
  })

  test('handles multiple configs and rules', () => {
    const configs: AutoLabelConfig[] = [
      {
        labelId: 'severity',
        rules: [
          { pattern: '\\b(critical|high|medium|low)\\b' },
        ],
      },
      {
        labelId: 'component',
        rules: [
          { pattern: '\\[([a-z-]+)\\]' },
        ],
      },
    ]

    const text = '[auth] critical: login fails for OAuth users'
    const matches = evaluateAutoLabels(text, configs)
    expect(matches).toHaveLength(2)
    expect(matches.find(m => m.labelId === 'severity')!.value).toBe('critical')
    expect(matches.find(m => m.labelId === 'component')!.value).toBe('auth')
  })
})

describe('Number Value Normalization', () => {
  test('strips currency symbols', () => {
    expect(normalizeNumberValue('$45')).toBe('45')
    expect(normalizeNumberValue('€1.50')).toBe('1.5')
    expect(normalizeNumberValue('£100')).toBe('100')
  })

  test('strips commas', () => {
    expect(normalizeNumberValue('45,000')).toBe('45000')
    expect(normalizeNumberValue('1,234,567')).toBe('1234567')
  })

  test('expands k/M/B suffixes', () => {
    expect(normalizeNumberValue('10k')).toBe('10000')
    expect(normalizeNumberValue('2.5M')).toBe('2500000')
    expect(normalizeNumberValue('1B')).toBe('1000000000')
    expect(normalizeNumberValue('1.5K')).toBe('1500')
  })

  test('preserves decimals', () => {
    expect(normalizeNumberValue('3.14')).toBe('3.14')
  })

  test('returns original for non-numeric strings', () => {
    expect(normalizeNumberValue('hello')).toBe('hello')
  })
})

describe('Auto-Label Pattern Validation', () => {
  test('validates correct regex', () => {
    const result = validateAutoLabelPattern('\\b(bug|defect)\\b')
    expect(result.errors).toHaveLength(0)
  })

  test('rejects invalid regex', () => {
    const result = validateAutoLabelPattern('[invalid(')
    expect(result.errors.length).toBeGreaterThan(0)
  })

  test('detects catastrophic backtracking', () => {
    const result = validateAutoLabelPattern('(a+)+')
    expect(result.errors.some(e => e.includes('nested quantifiers'))).toBe(true)
  })

  test('warns about missing capture groups', () => {
    const result = validateAutoLabelPattern('\\bbug\\b')
    expect(result.warnings.some(w => w.includes('no capture groups'))).toBe(true)
  })

  test('no warning for patterns with capture groups', () => {
    const result = validateAutoLabelPattern('(\\w+)')
    expect(result.warnings.filter(w => w.includes('capture'))).toHaveLength(0)
  })
})
