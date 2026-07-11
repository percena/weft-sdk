/**
 * Core utilities
 */

export { debug } from './debug.ts';
export { normalizePath, pathStartsWith, stripPathPrefix } from './paths.ts';
export { asRecord, stringValue, booleanValue, numberValue } from './type-guards.ts';
export {
  parseIPv4,
  isPrivateIPv4,
  expandIPv6,
  isPrivateIPv6,
  isPrivateHost,
  SsrfBlockedError,
  fetchWithSsrfGuard,
} from './ssrf.ts';
export type { SsrfGuardOptions } from './ssrf.ts';

/**
 * Test whether a glob pattern matches a value.
 *
 * Supports `*` (single path segment) and `**` (any depth).
 */
export function globMatches(pattern: string, value: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '__DOUBLE_STAR__')
    .replace(/\*/g, '[^/]*')
    .replace(/__DOUBLE_STAR__/g, '.*')
  return new RegExp(`^${escaped}$`).test(value)
}
