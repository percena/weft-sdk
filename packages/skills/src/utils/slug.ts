/**
 * Slug Validation
 *
 * Skills are stored in directories named by slug, and slugs arrive from
 * IPC/user input. They must be validated before being joined into filesystem
 * paths to prevent path traversal (e.g. "../x", "a/b", or absolute paths).
 */

import { resolve, sep } from 'node:path';

/**
 * Valid slug: starts with a lowercase letter or digit, followed by lowercase
 * letters, digits, hyphens, or underscores. Matches everything the slug
 * generators in this codebase produce (lowercase alphanumerics + hyphens).
 */
const SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

/**
 * Check if a value is a valid slug (safe to use as a directory name).
 */
export function isValidSlug(slug: string): boolean {
  return typeof slug === 'string' && SLUG_PATTERN.test(slug);
}

/**
 * Assert that a slug is valid, throwing a clear error otherwise.
 * Call at the entry of every storage function that accepts a slug.
 */
export function assertValidSlug(slug: string, label = 'slug'): void {
  if (!isValidSlug(slug)) {
    throw new Error(
      `Invalid ${label}: ${JSON.stringify(slug)} — must contain only lowercase letters, digits, hyphens, and underscores, and start with a letter or digit`
    );
  }
}

/**
 * Assert that a slug-derived path stays inside its root directory.
 * Defense in depth behind assertValidSlug: even if slug validation is
 * bypassed, no filesystem operation may escape the root.
 */
export function assertPathWithinRoot(root: string, target: string): void {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  if (!resolvedTarget.startsWith(resolvedRoot + sep)) {
    throw new Error(`Path escapes storage root: ${JSON.stringify(target)}`);
  }
}
