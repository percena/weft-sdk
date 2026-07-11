/**
 * Format a skill prerequisite directive that instructs the agent to read
 * SKILL.md files before taking any other action.
 *
 * Returns undefined if no prerequisite files are specified.
 */
export function formatSkillDirective(prerequisiteFiles: string[]): string | undefined {
  if (prerequisiteFiles.length === 0) return undefined

  const fileList = prerequisiteFiles.map(f => `- ${f}`).join('\n')
  return [
    'Before proceeding with the user\'s request, you MUST read the following skill instruction files:',
    fileList,
    'Do not take any other action until you have read these files.',
  ].join('\n')
}

/**
 * Prepend a skill directive to a user message if prerequisite files exist.
 * Returns the original message if no prerequisites.
 */
export function prependSkillDirective(
  message: string,
  prerequisiteFiles: string[],
): string {
  const directive = formatSkillDirective(prerequisiteFiles)
  if (!directive) return message
  return `${directive}\n\n${message}`
}
