/**
 * Labels Values Stub
 *
 * Provides label ID extraction used by automations.
 * Stubbed for OSS extraction — the real label utilities are in the main app.
 */

/**
 * Extract the label ID from a label string.
 * Handles formats like "priority::3" → "priority".
 * Stub: returns the label string itself (no structured labels in OSS package).
 */
export function extractLabelId(label: string): string {
  const separatorIndex = label.indexOf('::');
  if (separatorIndex !== -1) {
    return label.slice(0, separatorIndex);
  }
  return label;
}