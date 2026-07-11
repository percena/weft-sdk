export type SourceAuthoringPath = 'source' | 'browser-fallback'
export type SourceAuthReliability = 'stable' | 'brittle' | 'unknown'

export interface SourceAuthoringPlanInput {
  serviceName: string
  workspaceId: string
  purpose?: string
  repeatable?: boolean
  structuredAccess?: boolean
  authReliability?: SourceAuthReliability
  uiOnly?: boolean
}

export interface SourceBrowserFallbackDecision {
  reason: 'one_off_or_ui_only' | 'brittle_auth' | 'not_structured'
  reusableSourceLater: boolean
  detail: string
}

export interface SourceAuthoringPlan {
  recommendedPath: SourceAuthoringPath
  workspaceId: string
  purpose?: string
  source: {
    id: string
    slug: string
    name: string
    provider: string
  }
  validationSteps: string[]
  browserFallbackDecision?: SourceBrowserFallbackDecision
}

export function createSourceAuthoringPlan(input: SourceAuthoringPlanInput): SourceAuthoringPlan {
  const slug = slugify(input.serviceName)
  const fallbackDecision = decideSourceBrowserFallback(input)

  return {
    recommendedPath: fallbackDecision ? 'browser-fallback' : 'source',
    workspaceId: input.workspaceId,
    ...(input.purpose ? { purpose: input.purpose } : {}),
    source: {
      id: `${slug}_planned`,
      slug,
      name: input.serviceName.trim(),
      provider: slug,
    },
    validationSteps: [
      'validate_config',
      'test_connection',
      'verify_auth',
      'write_guide',
      'seed_read_only_policy',
    ],
    ...(fallbackDecision ? { browserFallbackDecision: fallbackDecision } : {}),
  }
}

function decideSourceBrowserFallback(input: SourceAuthoringPlanInput): SourceBrowserFallbackDecision | undefined {
  if (input.uiOnly || input.repeatable === false) {
    return {
      reason: 'one_off_or_ui_only',
      reusableSourceLater: true,
      detail: 'Prefer browser fallback for one-off or UI-only work; create a source later when the workflow becomes repeatable.',
    }
  }
  if (input.authReliability === 'brittle') {
    return {
      reason: 'brittle_auth',
      reusableSourceLater: true,
      detail: 'Prefer browser fallback until source authentication is reliable enough to reuse.',
    }
  }
  if (input.structuredAccess === false) {
    return {
      reason: 'not_structured',
      reusableSourceLater: true,
      detail: 'Prefer browser fallback because the task does not need reusable structured access.',
    }
  }
  return undefined
}

function slugify(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'source'
}
