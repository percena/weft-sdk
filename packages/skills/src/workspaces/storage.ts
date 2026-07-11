/**
 * Workspace Storage Stub
 *
 * Provides workspace path resolution for the skills package.
 * Stubbed for OSS extraction — the real workspace storage manages
 * workspace directories in the main app.
 */

import { join } from 'node:path';

/**
 * Get the path to the skills directory within a workspace.
 * Returns {workspaceRoot}/skills/
 *
 * @param workspaceRoot - Absolute path to workspace root
 * @returns Path to skills directory
 */
export function getWorkspaceSkillsPath(workspaceRoot: string): string {
  return join(workspaceRoot, 'skills');
}