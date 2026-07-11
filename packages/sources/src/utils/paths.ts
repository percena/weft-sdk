/**
 * Path Utility Stub
 *
 * Provides path expansion and portability utilities for the sources package.
 * Stubbed for OSS extraction — the real implementation handles cross-platform
 * path variables like $HOME, ~, and Windows-style paths.
 */

/**
 * Expand path variables in a path string.
 * Handles $HOME, ~, and environment variables.
 * Stub: returns the path as-is (no expansion in type checking).
 */
export function expandPath(path: string): string {
  // Basic expansion: handle ~ and $HOME
  if (path.startsWith('~')) {
    const { homedir } = require('node:os');
    return path.replace('~', homedir());
  }
  return path;
}

/**
 * Convert a path to portable form for config storage.
 * Replaces absolute home directory paths with ~ prefix.
 */
export function toPortablePath(path: string): string {
  const { homedir } = require('node:os');
  const home = homedir();
  if (path.startsWith(home)) {
    return `~${path.slice(home.length)}`;
  }
  return path;
}