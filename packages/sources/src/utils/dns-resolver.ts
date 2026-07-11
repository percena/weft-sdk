/**
 * Node DNS resolver for the SSRF guard.
 *
 * Resolves a hostname to all its IPs so `fetchWithSsrfGuard` (from `@weft/core`)
 * can reject names that point at private ranges (e.g. `localtest.me` → 127.0.0.1,
 * `169.254.169.254.nip.io` → 169.254.169.254). Without a resolver the guard
 * checks only literal-IP hostnames, so a DNS name that resolves to a private IP
 * bypasses the block on redirect hops (an open redirect on a source API can
 * 302 to `http://169.254.169.254.nip.io/…` and reach cloud metadata).
 *
 * This mirrors `nodeDnsResolveAll` in `@weft/automations/src/webhook-utils.ts`.
 * It is intentionally duplicated rather than shared: `@weft/core` stays free of
 * `node:` imports (its SSRF guard accepts the resolver as an injected option),
 * and `@weft/sources` does not depend on `@weft/automations` (the dependency
 * runs the other way). The dynamic `import('node:dns')` keeps this module
 * importable from bundles that may be loaded in a non-Node context — the
 * resolver only runs when actually invoked.
 *
 * Fails open (returns `[]`) on lookup error: the fetch itself fails on an
 * unresolvable host, and failing closed on a transient DNS error would
 * needlessly block legitimate API calls.
 */
export async function nodeDnsResolveAll(hostname: string): Promise<string[]> {
  const { lookup } = await import('node:dns')
  return new Promise<string[]>((resolve) => {
    lookup(hostname, { all: true }, (err, addresses) => {
      if (err || !addresses) return resolve([])
      resolve(addresses.map((a) => a.address))
    })
  })
}
