export interface AutoLabelRuleValidation {
  errors: string[]
  warnings: string[]
}

const NESTED_QUANTIFIER = /(\([^)]*[+*][^)]*\))[+*]|\(\?[^)]*[+*][^)]*\)[+*]/

export function validateAutoLabelPattern(pattern: string, flags?: string): AutoLabelRuleValidation {
  const errors: string[] = []
  const warnings: string[] = []

  try {
    new RegExp(pattern, flags ?? 'gi')
  } catch (err) {
    errors.push(`Invalid regex: ${String(err)}`)
    return { errors, warnings }
  }

  if (NESTED_QUANTIFIER.test(pattern)) {
    errors.push(`Pattern contains nested quantifiers that may cause catastrophic backtracking: ${pattern}`)
  }

  try {
    const re = new RegExp(pattern, flags ?? 'gi')
    if (!re.global) {
      warnings.push('Pattern should have the "g" flag to avoid infinite loops')
    }
  } catch {
    // already reported above
  }

  const captureGroupCount = (pattern.match(/\((?!\?)/g) || []).length
  if (captureGroupCount === 0) {
    warnings.push('Pattern has no capture groups — the entire match will be used as the value')
  }

  return { errors, warnings }
}
