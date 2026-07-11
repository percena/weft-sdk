import type { TimelineItem } from '@weft/timeline'

import { unique } from './internal-utils.ts'

export type SourceActivationStatus = 'active' | 'disabled' | 'needs_auth' | 'failed' | 'missing'

export interface SourceStateSnapshot {
  sourceSlug: string
  enabled: boolean
  authenticated: boolean
  status: SourceActivationStatus
  reason?: string
}

export interface CreateSourceActivationPlanOptions {
  requestedSourceSlugs: string[]
  sourceStates: SourceStateSnapshot[]
}

export interface SourceActivationPlan {
  requestedSourceSlugs: string[]
  activeSourceSlugs: string[]
  authRequiredSourceSlugs: string[]
  missingSourceSlugs: string[]
  blockedSourceSlugs: string[]
  timelineItems: TimelineItem[]
}

export function createSourceActivationPlan(
  options: CreateSourceActivationPlanOptions,
): SourceActivationPlan {
  const requestedSourceSlugs = unique(options.requestedSourceSlugs)
  const states = new Map(options.sourceStates.map(source => [source.sourceSlug, source]))
  const activeSourceSlugs: string[] = []
  const authRequiredSourceSlugs: string[] = []
  const missingSourceSlugs: string[] = []
  const blockedSourceSlugs: string[] = []
  const timelineItems: TimelineItem[] = []

  for (const sourceSlug of requestedSourceSlugs) {
    const state = states.get(sourceSlug) ?? {
      sourceSlug,
      enabled: false,
      authenticated: false,
      status: 'missing' as const,
    }

    if (state.enabled && state.authenticated && state.status === 'active') {
      activeSourceSlugs.push(sourceSlug)
    } else if (state.enabled && !state.authenticated) {
      authRequiredSourceSlugs.push(sourceSlug)
    } else if (state.status === 'missing') {
      missingSourceSlugs.push(sourceSlug)
    } else {
      blockedSourceSlugs.push(sourceSlug)
    }

    timelineItems.push({
      type: 'source_state_changed',
      source: {
        sourceSlug: state.sourceSlug,
        status: state.status,
        enabled: state.enabled,
        authenticated: state.authenticated,
        ...(state.reason ? { reason: state.reason } : {}),
      },
    })
  }

  return {
    requestedSourceSlugs,
    activeSourceSlugs,
    authRequiredSourceSlugs,
    missingSourceSlugs,
    blockedSourceSlugs,
    timelineItems,
  }
}
