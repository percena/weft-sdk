export function unique(values: string[]): string[] {
  return [...new Set(values)]
}

export function isCredentialHeader(key: string): boolean {
  const normalized = key.toLowerCase()
  return (
    normalized === 'authorization' ||
    normalized === 'proxy-authorization' ||
    normalized === 'cookie' ||
    normalized === 'set-cookie' ||
    normalized.includes('api-key') ||
    normalized.includes('apikey') ||
    normalized.includes('token') ||
    normalized.includes('secret')
  )
}

export function scrubCredentialHeaders(headers: Record<string, string>): Record<string, string> {
  const scrubbed: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    if (isCredentialHeader(key)) continue
    scrubbed[key] = value
  }
  return scrubbed
}
