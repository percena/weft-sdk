import { homedir } from 'node:os';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { debug } from './utils/debug.ts';

/**
 * Expand ~ to home directory
 */
export function expandHome(path: string): string {
  if (path.startsWith('~/') || path === '~') {
    return path.replace(/^~/, homedir());
  }
  return path;
}

/**
 * Convert a simple glob pattern to a regex
 * Supports: ** (recursive), * (single segment), ? (single char)
 */
export function globToRegex(pattern: string): RegExp {
  // Expand ~ in pattern
  const expandedPattern = expandHome(pattern);

  // Escape special regex chars except glob wildcards
  const regex = expandedPattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')  // Escape regex special chars
    .replace(/\*\*/g, '\0DOUBLE_STAR\0')   // Temporarily replace **
    .replace(/\*/g, '[^/]*')                // * matches single path segment
    .replace(/\0DOUBLE_STAR\0/g, '.*')      // ** matches anything including /
    .replace(/\?/g, '.');                   // ? matches single char

  return new RegExp(`^${regex}$`);
}

/**
 * Check if a path matches any of the allowed write path patterns
 */
export function matchesAllowedWritePath(filePath: string, allowedPaths: string[]): boolean {
  // Normalize path (expand ~, resolve, and use forward slashes)
  const normalizedPath = normalizeForComparison(expandHome(filePath));

  for (const pattern of allowedPaths) {
    try {
      const regex = globToRegex(pattern);
      if (regex.test(normalizedPath)) {
        debug(`[Mode] Path "${normalizedPath}" matches allowed pattern "${pattern}"`);
        return true;
      }
    } catch (e) {
      debug(`[Mode] Invalid glob pattern "${pattern}":`, e);
    }
  }
  return false;
}

/**
 * Normalize a path for cross-platform comparison.
 * - Resolve to absolute path
 * - Convert backslashes to forward slashes
 * - Lowercase on Windows for case-insensitive comparison
 */
export function normalizeForComparison(path: string): string {
  const normalized = resolve(path).replace(/\\/g, '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export function isWithin(base: string, target: string): boolean {
  const normalizedBase = normalizeForComparison(base);
  const normalizedTarget = normalizeForComparison(target);
  const rel = relative(normalizedBase, normalizedTarget);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Check whether targetPath is inside baseDir (or exactly equal to it).
 *
 * Uses path.relative semantics to avoid sibling-prefix bypasses and then
 * re-validates using real paths to prevent symlink escapes.
 */
export function isPathWithinDirectory(targetPath: string, baseDir: string): boolean {
  const expandedTarget = expandHome(targetPath);
  const expandedBase = expandHome(baseDir);

  const resolvedTarget = resolve(expandedTarget);
  const resolvedBase = resolve(expandedBase);
  if (!isWithin(resolvedBase, resolvedTarget)) {
    return false;
  }

  const realBase = existsSync(resolvedBase) ? realpathSync.native(resolvedBase) : resolvedBase;

  if (existsSync(resolvedTarget)) {
    const realTarget = realpathSync.native(resolvedTarget);
    return isWithin(realBase, realTarget);
  }

  // Target may be a new file path. Validate using nearest existing ancestor
  // to prevent symlink escapes while still allowing legitimate new files.
  let current = dirname(resolvedTarget);
  while (true) {
    if (existsSync(current)) {
      const realCurrent = realpathSync.native(current);
      return isWithin(realBase, realCurrent);
    }
    const parent = dirname(current);
    if (parent === current) {
      return false;
    }
    current = parent;
  }
}
