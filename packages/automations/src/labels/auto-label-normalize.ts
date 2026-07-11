const CURRENCY_PREFIX = /^[$€£¥]/
const COMMA_SEPARATOR = /,/g
const SUFFIX_MULTIPLIERS: Record<string, number> = {
  k: 1_000,
  m: 1_000_000,
  b: 1_000_000_000,
}

export function normalizeNumberValue(raw: string): string {
  const cleaned = raw.trim().replace(CURRENCY_PREFIX, '').replace(COMMA_SEPARATOR, '')

  const suffixMatch = cleaned.match(/^(-?[\d.]+)([kmb])$/i)
  if (suffixMatch) {
    const base = parseFloat(suffixMatch[1]!)
    const multiplier = SUFFIX_MULTIPLIERS[suffixMatch[2]!.toLowerCase()]!
    const result = base * multiplier
    return Number.isInteger(result) ? String(result) : result.toFixed(2)
  }

  const num = parseFloat(cleaned)
  if (Number.isNaN(num)) return raw.trim()

  return String(num)
}
