/**
 * Type declarations for incr-regex-package
 *
 * incr-regex-package provides incremental regex matching for
 * character-by-character pattern analysis.
 */

declare module 'incr-regex-package' {
  export const DONE: symbol;
  export const MORE: symbol;
  export const FAILED: symbol;

  interface IncrementalRegexResult {
    type: symbol;
    value?: string;
  }

  /**
   * Incremental regex matcher that processes characters one at a time.
   */
  export class IREGEX {
    constructor(pattern: string);
    /**
     * Process the entire string and return match result.
     * Returns [success, charCount, matchedString].
     */
    matchStr(input: string): [boolean, number, string | null];
    /**
     * Process a single character.
     */
    match(char: string): IncrementalRegexResult;
    /**
     * Reset the matcher state.
     */
    reset(): void;
  }

  export function createIncrementalRegex(pattern: string): {
    match(char: string): IncrementalRegexResult;
    reset(): void;
  };
}