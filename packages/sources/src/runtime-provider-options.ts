import type {
  ProviderSourceToolDescriptor,
  RuntimeExtensionContext,
} from '@weft/runtime-core'
import { sanitizeProviderSourceTools } from '@weft/runtime-core'
import type { TimelineItem } from '@weft/timeline'

import { scrubCredentialHeaders } from './internal-utils.ts'
import {
  createSourceRuntimeAssemblyPlan,
  type CreateSourceRuntimeAssemblyPlanOptions,
} from './runtime-assembly.ts'

export interface SourceRuntimeCapabilityDegradation {
  authRequiredSourceSlugs: string[]
  missingSourceSlugs: string[]
  blockedSourceSlugs: string[]
  toolBlockedSourceSlugs: string[]
}

export interface SourceRuntimeProviderOptions {
  extensions: Pick<RuntimeExtensionContext, 'sources'>
  sourceTools: ProviderSourceToolDescriptor[]
  timelineItems: TimelineItem[]
  capabilityDegradation: SourceRuntimeCapabilityDegradation
}

export function createSourceRuntimeProviderOptions(
  options: CreateSourceRuntimeAssemblyPlanOptions,
): SourceRuntimeProviderOptions {
  const plan = createSourceRuntimeAssemblyPlan(options)
  const sourceTools = sanitizeProviderSourceTools(
    scrubProviderCredentialHeaders(plan.sourceTools as ProviderSourceToolDescriptor[]),
  )

  return {
    extensions: {
      sources: {
        enabledSourceSlugs: plan.activeSourceSlugs,
      },
    },
    sourceTools,
    timelineItems: plan.timelineItems,
    capabilityDegradation: {
      authRequiredSourceSlugs: plan.authRequiredSourceSlugs,
      missingSourceSlugs: plan.missingSourceSlugs,
      blockedSourceSlugs: plan.blockedSourceSlugs,
      toolBlockedSourceSlugs: plan.toolBlockedSourceSlugs,
    },
  }
}

function scrubProviderCredentialHeaders(
  sourceTools: ProviderSourceToolDescriptor[],
): ProviderSourceToolDescriptor[] {
  return sourceTools.map(sourceTool => {
    if (sourceTool.kind === 'api-source' && sourceTool.defaultHeaders) {
      const defaultHeaders = scrubCredentialHeaders(sourceTool.defaultHeaders)
      return {
        ...sourceTool,
        ...(Object.keys(defaultHeaders).length > 0 ? { defaultHeaders } : { defaultHeaders: undefined }),
      }
    }

    if (sourceTool.kind === 'mcp-server' && sourceTool.headers) {
      const headers = scrubCredentialHeaders(sourceTool.headers)
      return {
        ...sourceTool,
        ...(Object.keys(headers).length > 0 ? { headers } : { headers: undefined }),
      }
    }

    return sourceTool
  })
}
