/**
 * Session Tools Stub
 *
 * Provides stub implementations for session tool definitions that were
 * previously defined in the upstream monorepo's session-tools module.
 * These tools are not being extracted into the Weft package, so
 * we provide empty stubs to satisfy import requirements.
 *
 * getToolDefsAsJsonSchema() returns an empty array and SESSION_TOOL_NAMES
 * is an empty array.
 */

/**
 * A tool definition expressed as a JSON Schema object.
 * This is the format that AI model APIs expect for tool definitions.
 */
export interface JsonSchemaToolDef {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

/**
 * Options for generating tool definitions with optional prefix.
 */
export interface GetToolDefsOptions {
  /** Prefix to add to tool names (e.g., 'mcp__session__') */
  prefix?: string;
  /** Whether to include the developer feedback tool */
  includeDeveloperFeedback?: boolean;
}

/**
 * Get session tool definitions as JSON Schema objects.
 *
 * Stub implementation: returns an empty array since session tools
 * are not included in the extracted adaptor package.
 */
export function getToolDefsAsJsonSchema(_options?: GetToolDefsOptions): JsonSchemaToolDef[] {
  // Stub: no session tools defined in the extracted package
  return [];
}

/**
 * Get the list of tool names that are considered "session-safe"
 * (always allowed regardless of permission mode).
 *
 * Stub implementation: returns an empty array since session tools
 * are not included in the extracted adaptor package.
 */
export const SESSION_TOOL_NAMES: string[] = [];

/**
 * Get session-safe allowed tool names for a given permission mode.
 *
 * Stub implementation: returns an empty Set since session tools
 * are not included in the extracted adaptor package.
 */
export function getSessionSafeAllowedToolNames(_options?: GetToolDefsOptions): Set<string> {
  // Stub: no session tools defined in the extracted package
  return new Set<string>();
}