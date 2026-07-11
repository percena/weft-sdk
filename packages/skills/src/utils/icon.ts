/**
 * Icon Utility Stub
 *
 * Provides icon validation, discovery, and download utilities.
 * Used by skills and sources packages for managing source/skill icons.
 * Stubbed for OSS extraction — the real implementation uses network requests
 * and file system operations for icon handling.
 */

/**
 * Validate an icon value from frontmatter.
 * Accepts emoji characters and URLs. Rejects inline SVG and relative paths.
 *
 * @param value - The icon value from frontmatter
 * @param context - Context label for error messages (e.g., 'Skills', 'Sources')
 * @returns Validated icon string or undefined if invalid
 */
export function validateIconValue(value: unknown, context: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') return undefined;

  // Accept emoji (single character or emoji sequence)
  if (/^[\p{Emoji}\u200d\ufe0f]+$/u.test(value)) return value;

  // Accept URLs
  if (value.startsWith('http://') || value.startsWith('https://')) return value;

  // Reject everything else (relative paths, inline SVG, etc.)
  console.warn(`[${context}] Invalid icon value: "${value}". Only emoji and URLs are supported.`);
  return undefined;
}

/**
 * Find an icon file in a directory (icon.svg, icon.png, icon.webp, etc.)
 * Searches for common icon file names.
 *
 * @param dirPath - Directory to search for icon files
 * @returns Path to icon file or undefined if not found
 */
export function findIconFile(_dirPath: string): string | undefined {
  // Stub: no filesystem access in type checking
  return undefined;
}

/**
 * Download an icon from a URL and save it to a directory.
 *
 * @param dirPath - Directory to save the downloaded icon
 * @param iconUrl - URL to download the icon from
 * @param context - Context label for error messages
 * @returns Path to the downloaded icon file or null on failure
 */
export async function downloadIcon(_dirPath: string, iconUrl: string, context: string): Promise<string | null> {
  // Stub: no network access in OSS package type checking
  console.warn(`[${context}] Icon download stub: would download ${iconUrl}`);
  return null;
}

/**
 * Check if a skill/source needs its icon downloaded.
 * Returns true if metadata has a URL icon and no local icon file exists.
 *
 * @param icon - Icon value from metadata (emoji or URL)
 * @param iconPath - Path to local icon file (if exists)
 * @returns Whether the icon needs downloading
 */
export function needsIconDownload(icon: string | undefined, iconPath: string | undefined): boolean {
  if (!icon) return false;
  if (icon.startsWith('http://') || icon.startsWith('https://')) {
    return !iconPath;
  }
  return false;
}

/**
 * Check if a string is a URL (suitable for icon download).
 *
 * @param value - String to check
 * @returns Whether the value is a URL
 */
export function isIconUrl(value: string): boolean {
  return value.startsWith('http://') || value.startsWith('https://');
}