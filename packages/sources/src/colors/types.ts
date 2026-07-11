/**
 * Entity Color Types
 *
 * Provides color type definitions for source brand theming.
 * Supports light/dark mode color variants for UI consistency.
 */

/**
 * Entity color specification.
 * Can be a system color name or a light/dark mode variant.
 */
export type EntityColor =
  | string
  | {
      light: string;
      dark: string;
    };