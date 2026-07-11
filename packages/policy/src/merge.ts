import type { PolicyRuleSet, PolicyLayer, BlockedCommandHintRule } from './index.ts'

/**
 * Merge multiple PolicyRuleSets into one. Later entries take precedence
 * for blockedCommandHints (last hint per command wins), while array fields
 * (patterns, paths, endpoints) are concatenated and deduplicated.
 */
export function mergePolicyRuleSets(...sets: PolicyRuleSet[]): PolicyRuleSet {
  const merged: PolicyRuleSet = {}

  const bashPatterns = new Set<string>()
  const mcpPatterns = new Set<string>()
  const writePaths = new Set<string>()
  const apiEndpoints = new Map<string, string>()
  const hintsByCommand = new Map<string, BlockedCommandHintRule>()

  for (const set of sets) {
    if (set.allowedBashPatterns) {
      for (const p of set.allowedBashPatterns) bashPatterns.add(p)
    }
    if (set.allowedMcpPatterns) {
      for (const p of set.allowedMcpPatterns) mcpPatterns.add(p)
    }
    if (set.allowedWritePaths) {
      for (const p of set.allowedWritePaths) writePaths.add(p)
    }
    if (set.allowedApiEndpoints) {
      for (const ep of set.allowedApiEndpoints) {
        apiEndpoints.set(`${ep.method}::${ep.pattern}`, ep.pattern)
      }
    }
    if (set.blockedCommandHints) {
      for (const hint of set.blockedCommandHints) {
        hintsByCommand.set(hint.command, hint)
      }
    }
  }

  if (bashPatterns.size) merged.allowedBashPatterns = [...bashPatterns]
  if (mcpPatterns.size) merged.allowedMcpPatterns = [...mcpPatterns]
  if (writePaths.size) merged.allowedWritePaths = [...writePaths]
  if (apiEndpoints.size) {
    merged.allowedApiEndpoints = [...apiEndpoints.entries()].map(([key, pattern]) => ({
      method: key.split('::')[0]!,
      pattern,
    }))
  }
  if (hintsByCommand.size) merged.blockedCommandHints = [...hintsByCommand.values()]

  return merged
}

/**
 * Merge multiple PolicyLayers into a single flat layer. Used when
 * combining global + workspace file-based layers into one layer
 * before appending to a policy's existing layers.
 */
export function mergePolicyLayers(layers: PolicyLayer[], id: string): PolicyLayer | undefined {
  if (layers.length === 0) return undefined
  if (layers.length === 1) return { ...layers[0]!, id }

  const mergedRules = mergePolicyRuleSets(...layers.map(l => l.rules))
  return { id, rules: mergedRules }
}
