import type { TimelineItem } from '@weft/timeline'

import { unique } from './internal-utils.ts'
import {
  createSourceActivationPlan,
  type SourceStateSnapshot,
} from './activation.ts'
import {
  createSourceToolAssemblyPlan,
  type SourceCredentialRef,
  type SourceToolDescriptor,
} from './assembly.ts'
import type { LoadedSource } from './types.ts'

export interface CreateSourceRuntimeAssemblyPlanOptions {
  requestedSourceSlugs: string[]
  sourceStates: SourceStateSnapshot[]
  sources: LoadedSource[]
  credentialRefs?: Record<string, SourceCredentialRef>
  allowedStdioEnvKeys?: string[]
}

export interface SourceRuntimeAssemblyPlan {
  requestedSourceSlugs: string[]
  activeSourceSlugs: string[]
  authRequiredSourceSlugs: string[]
  missingSourceSlugs: string[]
  blockedSourceSlugs: string[]
  toolBlockedSourceSlugs: string[]
  sourceTools: SourceToolDescriptor[]
  timelineItems: TimelineItem[]
}

export function createSourceRuntimeAssemblyPlan(
  options: CreateSourceRuntimeAssemblyPlanOptions,
): SourceRuntimeAssemblyPlan {
  const activation = createSourceActivationPlan({
    requestedSourceSlugs: options.requestedSourceSlugs,
    sourceStates: options.sourceStates,
  })
  const toolAssembly = createSourceToolAssemblyPlan({
    activeSourceSlugs: activation.activeSourceSlugs,
    sources: options.sources,
    credentialRefs: options.credentialRefs,
    allowedStdioEnvKeys: options.allowedStdioEnvKeys,
  })

  return {
    requestedSourceSlugs: activation.requestedSourceSlugs,
    activeSourceSlugs: activation.activeSourceSlugs,
    authRequiredSourceSlugs: activation.authRequiredSourceSlugs,
    missingSourceSlugs: activation.missingSourceSlugs,
    blockedSourceSlugs: unique([
      ...activation.blockedSourceSlugs,
      ...toolAssembly.blockedSourceSlugs,
    ]),
    toolBlockedSourceSlugs: toolAssembly.blockedSourceSlugs,
    sourceTools: toolAssembly.tools,
    timelineItems: activation.timelineItems,
  }
}
