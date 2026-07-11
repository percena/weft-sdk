/**
 * math-options — stub for markdown math rendering options.
 *
 * Configures remark-math to only use $$ delimiters for display math,
 * disabling single-dollar inline math so currency like $2M stays plain text.
 */

export const MARKDOWN_MATH_OPTIONS = {
  singleDollarTextMath: false,
}