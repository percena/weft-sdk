/**
 * Workspace Storage Stub
 *
 * Provides workspace path resolution for the sources package.
 * Stubbed for OSS extraction — the real workspace storage manages
 * workspace directories in the main app.
 */

import { join } from 'node:path';

/**
 * Get the path to the sources directory within a workspace.
 * Returns {workspaceRoot}/sources/
 *
 * @param workspaceRootPath - Absolute path to workspace root
 * @returns Path to sources directory
 */
export function getWorkspaceSourcesPath(workspaceRootPath: string): string {
  return join(workspaceRootPath, 'sources');
}