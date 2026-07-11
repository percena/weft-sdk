/**
 * Icon Utility Stub
 *
 * Provides icon validation, discovery, and download utilities.
 * Used by the sources package for managing source icons.
 * Stubbed for OSS extraction — mirrors the skills package stub.
 */

/**
 * Validate an icon value from frontmatter.
 * Accepts emoji characters and URLs. Rejects inline SVG and relative paths.
 */
export function validateIconValue(value: unknown, context: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') return undefined;
  if (/^[\p{Emoji}\u200d\ufe0f]+$/u.test(value)) return value;
  if (value.startsWith('http://') || value.startsWith('https://')) return value;
  console.warn(`[${context}] Invalid icon value: "${value}". Only emoji and URLs are supported.`);
  return undefined;
}

/**
 * Find an icon file in a directory.
 */
export function findIconFile(_dirPath: string): string | undefined {
  return undefined;
}

/**
 * Download an icon from a URL.
 */
export async function downloadIcon(_dirPath: string, _iconUrl: string, _context: string): Promise<string | null> {
  return null;
}

/**
 * Check if a source needs its icon downloaded.
 */
export function needsIconDownload(icon: string | undefined, iconPath: string | undefined): boolean {
  if (!icon) return false;
  if (icon.startsWith('http://') || icon.startsWith('https://')) {
    return !iconPath;
  }
  return false;
}

/**
 * Check if a string is a URL.
 */
export function isIconUrl(value: string): boolean {
  return value.startsWith('http://') || value.startsWith('https://');
}