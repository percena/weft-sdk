import type { PolicyRuleSet, BlockedCommandHintRule, ApiEndpointRule, PolicyLayer } from './index.ts'
import { isValidRegex } from './utils.ts'

export interface PolicyFileContents {
  allowedBashPatterns?: string[]
  allowedMcpPatterns?: string[]
  allowedApiEndpoints?: ApiEndpointRule[]
  allowedWritePaths?: string[]
  blockedCommandHints?: BlockedCommandHintRule[]
}

export interface PolicyFileLoadResult {
  rules: PolicyRuleSet
  path: string
  errors: string[]
}

export interface LoadPolicyLayersOptions {
  globalPath?: string
  workspacePath?: string
}

async function getGlobalDefaultPath(): Promise<string> {
  const { join } = await import('node:path')
  const { homedir } = await import('node:os')
  return join(homedir(), '.weft', 'permissions.json')
}

export async function loadPolicyFile(filePath: string): Promise<PolicyFileLoadResult> {
  const { readFileSync, existsSync } = await import('node:fs')
  const errors: string[] = []

  if (!existsSync(filePath)) {
    return { rules: {}, path: filePath, errors: [] }
  }

  let raw: string
  try {
    raw = readFileSync(filePath, 'utf-8')
  } catch (err) {
    return { rules: {}, path: filePath, errors: [`Failed to read ${filePath}: ${String(err)}`] }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { rules: {}, path: filePath, errors: [`Invalid JSON in ${filePath}`] }
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { rules: {}, path: filePath, errors: [`Expected JSON object in ${filePath}`] }
  }

  const obj = parsed as Record<string, unknown>
  const rules: PolicyRuleSet = {}

  if (obj.allowedBashPatterns !== undefined) {
    const { values, errs } = validateStringArray(obj.allowedBashPatterns, 'allowedBashPatterns', filePath)
    errors.push(...errs)
    const { valid, invalid } = partitionByRegex(values)
    rules.allowedBashPatterns = valid
    for (const p of invalid) errors.push(`Invalid regex in ${filePath} allowedBashPatterns: ${p}`)
  }

  if (obj.allowedMcpPatterns !== undefined) {
    const { values, errs } = validateStringArray(obj.allowedMcpPatterns, 'allowedMcpPatterns', filePath)
    errors.push(...errs)
    const { valid, invalid } = partitionByRegex(values)
    rules.allowedMcpPatterns = valid
    for (const p of invalid) errors.push(`Invalid regex in ${filePath} allowedMcpPatterns: ${p}`)
  }

  if (obj.allowedWritePaths !== undefined) {
    const { values, errs } = validateStringArray(obj.allowedWritePaths, 'allowedWritePaths', filePath)
    rules.allowedWritePaths = values
    errors.push(...errs)
  }

  if (obj.allowedApiEndpoints !== undefined) {
    if (!Array.isArray(obj.allowedApiEndpoints)) {
      errors.push(`Expected array for allowedApiEndpoints in ${filePath}`)
    } else {
      rules.allowedApiEndpoints = []
      for (const entry of obj.allowedApiEndpoints) {
        if (!entry || typeof entry !== 'object') {
          errors.push(`Invalid API endpoint rule in ${filePath}: expected object`)
          continue
        }
        const e = entry as Record<string, unknown>
        if (typeof e.method !== 'string' || typeof e.pathPattern !== 'string') {
          errors.push(`API endpoint rule requires method and pathPattern in ${filePath}`)
          continue
        }
        rules.allowedApiEndpoints.push({ method: e.method.toUpperCase(), pattern: e.pathPattern })
      }
    }
  }

  if (obj.blockedCommandHints !== undefined) {
    if (!Array.isArray(obj.blockedCommandHints)) {
      errors.push(`Expected array for blockedCommandHints in ${filePath}`)
    } else {
      rules.blockedCommandHints = []
      for (const entry of obj.blockedCommandHints) {
        if (!entry || typeof entry !== 'object') {
          errors.push(`Invalid blocked command hint in ${filePath}: expected object`)
          continue
        }
        const e = entry as Record<string, unknown>
        if (typeof e.command !== 'string' || typeof e.reason !== 'string') {
          errors.push(`Blocked command hint requires command and reason in ${filePath}`)
          continue
        }
        const hint: BlockedCommandHintRule = {
          command: e.command,
          reason: e.reason,
        }
        if (typeof e.whenNotMatching === 'string') {
          if (isValidRegex(e.whenNotMatching)) {
            hint.whenNotMatching = e.whenNotMatching
          } else {
            errors.push(`Invalid regex in whenNotMatching for command "${e.command}" in ${filePath}`)
          }
        }
        if (Array.isArray(e.tryInstead)) {
          hint.tryInstead = e.tryInstead.filter((v): v is string => typeof v === 'string')
        }
        if (typeof e.context === 'string') {
          hint.context = e.context
        }
        rules.blockedCommandHints.push(hint)
      }
    }
  }

  return { rules, path: filePath, errors }
}

export async function loadPolicyLayers(options: LoadPolicyLayersOptions = {}): Promise<{
  layers: PolicyLayer[]
  errors: string[]
}> {
  const globalPath = options.globalPath ?? await getGlobalDefaultPath()
  const allErrors: string[] = []
  const layers: PolicyLayer[] = []

  const globalResult = await loadPolicyFile(globalPath)
  allErrors.push(...globalResult.errors)
  if (hasRules(globalResult.rules)) {
    layers.push({ id: 'file:global', rules: globalResult.rules })
  }

  if (options.workspacePath) {
    const wsResult = await loadPolicyFile(options.workspacePath)
    allErrors.push(...wsResult.errors)
    if (hasRules(wsResult.rules)) {
      layers.push({ id: 'file:workspace', rules: wsResult.rules })
    }
  }

  return { layers, errors: allErrors }
}

function hasRules(rules: PolicyRuleSet): boolean {
  return !!(
    rules.allowedBashPatterns?.length ||
    rules.allowedMcpPatterns?.length ||
    rules.allowedApiEndpoints?.length ||
    rules.allowedWritePaths?.length ||
    rules.blockedCommandHints?.length
  )
}

function validateStringArray(
  value: unknown,
  field: string,
  filePath: string,
): { values: string[]; errs: string[] } {
  if (!Array.isArray(value)) {
    return { values: [], errs: [`Expected array for ${field} in ${filePath}`] }
  }
  const values: string[] = []
  const errs: string[] = []
  for (const item of value) {
    if (typeof item === 'string') {
      values.push(item)
    } else {
      errs.push(`Non-string entry in ${field} in ${filePath}: ${JSON.stringify(item)}`)
    }
  }
  return { values, errs }
}

function partitionByRegex(patterns: string[]): { valid: string[]; invalid: string[] } {
  const valid: string[] = []
  const invalid: string[] = []
  for (const p of patterns) {
    ;(isValidRegex(p) ? valid : invalid).push(p)
  }
  return { valid, invalid }
}
