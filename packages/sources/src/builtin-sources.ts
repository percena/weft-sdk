/**
 * Built-in Sources
 *
 * System-level sources that are always available in every workspace.
 * These sources are not shown in the sources list UI but are available
 * for the agent to use.
 *
 * The docs source is now an always-available MCP server configured directly in
 * the host runtime, not a source. getBuiltinSources returns empty.
 */

import type { LoadedSource } from './types.ts';

/**
 * Get all built-in sources for a workspace.
 *
 * Currently returns empty array - the docs source has been moved to
 * an always-available MCP server in the host runtime.
 *
 * @param _workspaceId - The workspace ID (unused)
 * @param _workspaceRootPath - Absolute path to workspace root folder (unused)
 * @returns Empty array (no built-in sources)
 */
export function getBuiltinSources(_workspaceId: string, _workspaceRootPath: string): LoadedSource[] {
  return [];
}
