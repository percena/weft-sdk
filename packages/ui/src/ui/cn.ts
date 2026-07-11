/**
 * cn - Simple className merge utility
 *
 * Filters falsy values and joins remaining class names with spaces.
 * Simple falsy-filtering className joiner.
 */
export function cn(...classes: (string | undefined | null | false)[]): string {
  return classes.filter(Boolean).join(' ');
}