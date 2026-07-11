import { readFileSync } from 'node:fs'

/**
 * File Utility Stub
 *
 * Provides JSON file reading utilities for the sources package.
 * Stubbed for OSS extraction — the real implementation handles
 * atomic reads, lock files, and error recovery.
 */

/**
 * Synchronously read and parse a JSON file.
 *
 * @param filePath - Absolute path to the JSON file
 * @returns Parsed JSON content
 * @throws Error if file cannot be read or parsed
 */
export function readJsonFileSync<T = unknown>(filePath: string): T {
  const content = readFileSync(filePath, 'utf-8')
  return JSON.parse(content) as T
}
