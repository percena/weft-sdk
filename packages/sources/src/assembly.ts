import type {
  ApiAuthType,
  LoadedSource,
  McpTransport,
} from './types.ts'

import { scrubCredentialHeaders, unique } from './internal-utils.ts'

export type SourceCredentialRefType =
  | 'source_oauth'
  | 'source_bearer'
  | 'source_header'
  | 'source_query'
  | 'source_basic'
  | 'source_multi_header'

export interface SourceCredentialRef {
  type: SourceCredentialRefType
  sourceSlug: string
  workspaceId: string
}

export type SourceToolDescriptor =
  | {
    kind: 'api-source'
    sourceSlug: string
    baseUrl: string
    authType: ApiAuthType
    defaultHeaders?: Record<string, string>
    credentialRef?: SourceCredentialRef
  }
  | {
    kind: 'local-source'
    sourceSlug: string
    path: string
    format?: string
  }
  | {
    kind: 'mcp-server'
    sourceSlug: string
    transport: McpTransport
    url?: string
    command?: string
    args?: string[]
    env?: Record<string, string>
    headers?: Record<string, string>
    credentialRef?: SourceCredentialRef
  }

export interface CreateSourceToolAssemblyPlanOptions {
  activeSourceSlugs: string[]
  sources: LoadedSource[]
  credentialRefs?: Record<string, SourceCredentialRef>
  allowedStdioEnvKeys?: string[]
}

export interface SourceToolAssemblyPlan {
  tools: SourceToolDescriptor[]
  blockedSourceSlugs: string[]
}

export function createSourceToolAssemblyPlan(
  options: CreateSourceToolAssemblyPlanOptions,
): SourceToolAssemblyPlan {
  const bySlug = new Map(options.sources.map(source => [source.config.slug, source]))
  const tools: SourceToolDescriptor[] = []
  const blockedSourceSlugs: string[] = []

  for (const sourceSlug of unique(options.activeSourceSlugs)) {
    const source = bySlug.get(sourceSlug)
    if (!source) {
      blockedSourceSlugs.push(sourceSlug)
      continue
    }

    const descriptor = descriptorFromSource(
      source,
      options.credentialRefs?.[sourceSlug],
      options.allowedStdioEnvKeys ?? [],
    )
    if (descriptor) {
      tools.push(descriptor)
    } else {
      blockedSourceSlugs.push(sourceSlug)
    }
  }

  return { tools, blockedSourceSlugs }
}

function descriptorFromSource(
  source: LoadedSource,
  credentialRef: SourceCredentialRef | undefined,
  allowedStdioEnvKeys: string[],
): SourceToolDescriptor | undefined {
  const { config } = source
  if (config.type === 'api' && config.api) {
    return {
      kind: 'api-source',
      sourceSlug: config.slug,
      baseUrl: config.api.baseUrl,
      authType: config.api.authType,
      ...headersOption('defaultHeaders', config.api.defaultHeaders),
      ...(credentialRef ? { credentialRef } : {}),
    }
  }

  if (config.type === 'local' && config.local) {
    return {
      kind: 'local-source',
      sourceSlug: config.slug,
      path: config.local.path,
      ...(config.local.format ? { format: config.local.format } : {}),
    }
  }

  if (config.type === 'mcp' && config.mcp) {
    const transport = config.mcp.transport ?? 'http'
    return {
      kind: 'mcp-server',
      sourceSlug: config.slug,
      transport,
      ...(config.mcp.url ? { url: config.mcp.url } : {}),
      ...(config.mcp.command ? { command: config.mcp.command } : {}),
      ...(config.mcp.args ? { args: [...config.mcp.args] } : {}),
      ...(transport === 'stdio'
        ? { env: scrubEnv(config.mcp.env, allowedStdioEnvKeys) }
        : {}),
      ...(transport !== 'stdio' ? headersOption('headers', config.mcp.headers) : {}),
      ...(credentialRef ? { credentialRef } : {}),
    }
  }

  return undefined
}

function scrubEnv(
  env: Record<string, string> | undefined,
  allowedKeys: string[],
): Record<string, string> | undefined {
  if (!env) return undefined
  const allowed = new Set(allowedKeys)
  const scrubbed = Object.fromEntries(
    Object.entries(env).filter(([key]) => allowed.has(key)),
  )
  return Object.keys(scrubbed).length > 0 ? scrubbed : undefined
}

function headersOption<K extends 'defaultHeaders' | 'headers'>(
  key: K,
  headers: Record<string, string> | undefined,
): Record<K, Record<string, string>> | Record<string, never> {
  if (!headers) return {}
  const scrubbed = scrubCredentialHeaders(headers)
  return Object.keys(scrubbed).length > 0 ? { [key]: scrubbed } as Record<K, Record<string, string>> : {}
}
