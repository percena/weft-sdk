import { createHash } from 'node:crypto'

export function stableHash(value: unknown): string {
  return createHash('sha256')
    .update(stableStringify(value), 'utf8')
    .digest('hex')
    .slice(0, 16)
}

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
    return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export function redactSecrets(text: string): { text: string; redacted: boolean } {
  const patterns = [
    /(authorization\s*[:=]\s*)(bearer\s+)?[^\s,;]+/gi,
    /(token\s*[:=]\s*)[^\s,;]+/gi,
    /(api[_-]?key\s*[:=]\s*)[^\s,;]+/gi,
    /(secret\s*[:=]\s*)[^\s,;]+/gi,
  ]
  let redacted = false
  let output = text
  for (const pattern of patterns) {
    output = output.replace(pattern, (_match, ...args: unknown[]) => {
      const prefix = typeof args[0] === 'string' ? args[0] : ''
      const optionalPrefix = typeof args[1] === 'string' ? args[1] : ''
      redacted = true
      return `${prefix}${optionalPrefix}[REDACTED]`
    })
  }
  return { text: output, redacted }
}

export function cloneCommandOrigin<T extends { type: string }>(origin: T): T {
  return { ...origin }
}
