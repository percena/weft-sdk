/**
 * Shared utilities internal to the policy package.
 * Kept separate from index.ts so that loader.ts (a distinct entry point)
 * can import helpers without pulling in the full policy barrel.
 */

export function isValidRegex(pattern: string): boolean {
  try {
    new RegExp(pattern)
    return true
  } catch {
    return false
  }
}
