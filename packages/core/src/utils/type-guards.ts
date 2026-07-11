/**
 * Narrowing type guards shared across provider drivers and the rest of the
 * monorepo. Each returns the value when it matches the expected primitive
 * shape and a safe default (`undefined` for scalars, `{}` for `asRecord`)
 * otherwise, so call sites can read fields without null-check cascades.
 *
 * Kept in `@weft/core` (the L0 base) so every layer — `policy`, `runtime-core`,
 * `adapter`, `cli-runtime`, `providers`, … — can depend on one copy instead of
 * re-defining the quartet per package.
 */

/** Coerce an unknown value into a record, defaulting to `{}` for non-objects. */
export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

/** Return the value if it is a string, otherwise `undefined`. */
export function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** Return the value if it is a boolean, otherwise `undefined`. */
export function booleanValue(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

/** Return the value if it is a number, otherwise `undefined`. */
export function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined
}
