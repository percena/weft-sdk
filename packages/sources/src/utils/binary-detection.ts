/**
 * Binary Detection Utilities — Stub for OSS extraction.
 *
 * Provides constants and helpers for detecting and handling binary responses.
 * Stub: uses conservative defaults.
 */

/** Maximum download size in bytes (50 MB default) */
export const MAX_DOWNLOAD_SIZE = 50 * 1024 * 1024;

/**
 * Format byte count as human-readable string.
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const value = bytes / 1024 ** i;
  return `${value.toFixed(1)} ${units[i]}`;
}