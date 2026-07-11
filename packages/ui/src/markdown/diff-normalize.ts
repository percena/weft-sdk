/**
 * diff-normalize — stub for unified diff format normalization.
 */

export function ensureUnifiedDiffFormat(diffContent: string): string {
  // If the content already has proper --- +++ headers, return as-is
  if (diffContent.startsWith('---')) {
    return diffContent
  }

  // Otherwise, wrap with synthetic headers
  return `--- a/file\n+++ b/file\n${diffContent}`
}