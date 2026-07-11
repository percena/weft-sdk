/**
 * Labels Storage Stub
 *
 * Provides label validation used by automations.
 * Stubbed for OSS extraction — the real label storage is in the main app.
 */

/**
 * Check if a label ID exists in the workspace.
 * Stub: returns true (all labels are considered valid in OSS package).
 */
export function isValidLabelId(_workspaceRoot: string, _labelId: string): boolean {
  return true;
}