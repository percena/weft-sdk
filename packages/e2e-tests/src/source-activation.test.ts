import { describe, expect, test } from 'vitest'

import {
  createSourceActivationPlan,
  createSourceRuntimeProviderOptions,
  createSourceRuntimeAssemblyPlan,
  createSourceToolAssemblyPlan,
  type LoadedSource,
  type SourceStateSnapshot,
} from '@weft/sources'

describe('Sources — provider-neutral activation gate', () => {
  test('separates active, missing, and auth-required sources', () => {
    const sourceStates: SourceStateSnapshot[] = [
      { sourceSlug: 'github', enabled: true, authenticated: true, status: 'active' },
      { sourceSlug: 'linear', enabled: true, authenticated: false, status: 'needs_auth' },
    ]

    const plan = createSourceActivationPlan({
      requestedSourceSlugs: ['github', 'linear', 'slack', 'github'],
      sourceStates,
    })

    expect(plan.activeSourceSlugs).toEqual(['github'])
    expect(plan.authRequiredSourceSlugs).toEqual(['linear'])
    expect(plan.missingSourceSlugs).toEqual(['slack'])
    expect(plan.timelineItems).toEqual([
      {
        type: 'source_state_changed',
        source: {
          sourceSlug: 'github',
          status: 'active',
          enabled: true,
          authenticated: true,
        },
      },
      {
        type: 'source_state_changed',
        source: {
          sourceSlug: 'linear',
          status: 'needs_auth',
          enabled: true,
          authenticated: false,
        },
      },
      {
        type: 'source_state_changed',
        source: {
          sourceSlug: 'slack',
          status: 'missing',
          enabled: false,
          authenticated: false,
        },
      },
    ])
  })

  test('assembles provider-neutral source tools without leaking credential values', () => {
    const sources: LoadedSource[] = [
      loadedSource({
        slug: 'github',
        type: 'api',
        api: {
          baseUrl: 'https://api.github.com',
          authType: 'bearer',
          defaultHeaders: {
            Accept: 'application/json',
            Authorization: 'Bearer secret-value',
          },
        },
      }),
      loadedSource({
        slug: 'docs',
        type: 'local',
        local: { path: '/workspace/docs', format: 'filesystem' },
      }),
      loadedSource({
        slug: 'linear',
        type: 'mcp',
        mcp: {
          transport: 'stdio',
          command: 'linear-mcp',
          args: ['--stdio'],
          env: {
            PATH: '/usr/bin',
            LINEAR_API_KEY: 'secret-value',
          },
        },
      }),
    ]

    const plan = createSourceToolAssemblyPlan({
      activeSourceSlugs: ['github', 'docs', 'linear', 'missing'],
      sources,
      credentialRefs: {
        github: { type: 'source_bearer', sourceSlug: 'github', workspaceId: 'workspace-a' },
      },
      allowedStdioEnvKeys: ['PATH'],
    })

    expect(plan.blockedSourceSlugs).toEqual(['missing'])
    expect(plan.tools).toEqual([
      {
        kind: 'api-source',
        sourceSlug: 'github',
        baseUrl: 'https://api.github.com',
        authType: 'bearer',
        defaultHeaders: { Accept: 'application/json' },
        credentialRef: { type: 'source_bearer', sourceSlug: 'github', workspaceId: 'workspace-a' },
      },
      {
        kind: 'local-source',
        sourceSlug: 'docs',
        path: '/workspace/docs',
        format: 'filesystem',
      },
      {
        kind: 'mcp-server',
        sourceSlug: 'linear',
        transport: 'stdio',
        command: 'linear-mcp',
        args: ['--stdio'],
        env: { PATH: '/usr/bin' },
      },
    ])
    expect(JSON.stringify(plan)).not.toContain('secret-value')
  })

  test('combines activation and source tool assembly for runtime construction', () => {
    const sources: LoadedSource[] = [
      loadedSource({
        slug: 'github',
        type: 'api',
        api: {
          baseUrl: 'https://api.github.com',
          authType: 'bearer',
          defaultHeaders: { Accept: 'application/json' },
        },
      }),
      loadedSource({
        slug: 'linear',
        type: 'mcp',
        mcp: {
          transport: 'stdio',
          command: 'linear-mcp',
          env: {
            PATH: '/usr/bin',
            LINEAR_API_KEY: 'secret-value',
          },
        },
      }),
    ]
    const sourceStates: SourceStateSnapshot[] = [
      { sourceSlug: 'github', enabled: true, authenticated: true, status: 'active' },
      { sourceSlug: 'linear', enabled: true, authenticated: true, status: 'active' },
      { sourceSlug: 'slack', enabled: true, authenticated: false, status: 'needs_auth' },
      { sourceSlug: 'blocked', enabled: false, authenticated: false, status: 'disabled' },
    ]

    const plan = createSourceRuntimeAssemblyPlan({
      requestedSourceSlugs: ['github', 'linear', 'slack', 'missing', 'blocked', 'github'],
      sourceStates,
      sources,
      credentialRefs: {
        github: { type: 'source_bearer', sourceSlug: 'github', workspaceId: 'workspace-a' },
        linear: { type: 'source_oauth', sourceSlug: 'linear', workspaceId: 'workspace-a' },
      },
      allowedStdioEnvKeys: ['PATH'],
    })

    expect(plan.requestedSourceSlugs).toEqual(['github', 'linear', 'slack', 'missing', 'blocked'])
    expect(plan.activeSourceSlugs).toEqual(['github', 'linear'])
    expect(plan.authRequiredSourceSlugs).toEqual(['slack'])
    expect(plan.missingSourceSlugs).toEqual(['missing'])
    expect(plan.blockedSourceSlugs).toEqual(['blocked'])
    expect(plan.toolBlockedSourceSlugs).toEqual([])
    expect(plan.sourceTools).toEqual([
      {
        kind: 'api-source',
        sourceSlug: 'github',
        baseUrl: 'https://api.github.com',
        authType: 'bearer',
        defaultHeaders: { Accept: 'application/json' },
        credentialRef: { type: 'source_bearer', sourceSlug: 'github', workspaceId: 'workspace-a' },
      },
      {
        kind: 'mcp-server',
        sourceSlug: 'linear',
        transport: 'stdio',
        command: 'linear-mcp',
        env: { PATH: '/usr/bin' },
        credentialRef: { type: 'source_oauth', sourceSlug: 'linear', workspaceId: 'workspace-a' },
      },
    ])
    expect(plan.timelineItems).toHaveLength(5)
    expect(plan.timelineItems.map(item => item.type)).toEqual([
      'source_state_changed',
      'source_state_changed',
      'source_state_changed',
      'source_state_changed',
      'source_state_changed',
    ])
    expect(JSON.stringify(plan)).not.toContain('secret-value')
  })

  test('builds host-facing provider runtime options from source registry state', () => {
    const sources: LoadedSource[] = [
      loadedSource({
        slug: 'github',
        type: 'api',
        api: {
          baseUrl: 'https://api.github.com',
          authType: 'bearer',
          defaultHeaders: { Accept: 'application/json' },
        },
      }),
      loadedSource({
        slug: 'linear',
        type: 'mcp',
        mcp: {
          transport: 'stdio',
          command: 'linear-mcp',
          args: ['--stdio'],
          env: {
            PATH: '/usr/bin',
            LINEAR_API_KEY: 'secret-value',
          },
        },
      }),
    ]
    const sourceStates: SourceStateSnapshot[] = [
      { sourceSlug: 'github', enabled: true, authenticated: true, status: 'active' },
      { sourceSlug: 'linear', enabled: true, authenticated: true, status: 'active' },
      { sourceSlug: 'slack', enabled: true, authenticated: false, status: 'needs_auth' },
    ]

    const options = createSourceRuntimeProviderOptions({
      requestedSourceSlugs: ['github', 'linear', 'slack', 'missing'],
      sourceStates,
      sources,
      credentialRefs: {
        github: { type: 'source_bearer', sourceSlug: 'github', workspaceId: 'workspace-a' },
        linear: { type: 'source_oauth', sourceSlug: 'linear', workspaceId: 'workspace-a' },
      },
      allowedStdioEnvKeys: ['PATH'],
    })

    expect(options.extensions).toEqual({
      sources: {
        enabledSourceSlugs: ['github', 'linear'],
      },
    })
    expect(options.sourceTools).toEqual([
      {
        kind: 'api-source',
        sourceSlug: 'github',
        baseUrl: 'https://api.github.com',
        authType: 'bearer',
        defaultHeaders: { Accept: 'application/json' },
        credentialRef: { type: 'source_bearer', sourceSlug: 'github', workspaceId: 'workspace-a' },
      },
      {
        kind: 'mcp-server',
        sourceSlug: 'linear',
        transport: 'stdio',
        command: 'linear-mcp',
        args: ['--stdio'],
        env: { PATH: '/usr/bin' },
        credentialRef: { type: 'source_oauth', sourceSlug: 'linear', workspaceId: 'workspace-a' },
      },
    ])
    expect(options.capabilityDegradation).toEqual({
      authRequiredSourceSlugs: ['slack'],
      missingSourceSlugs: ['missing'],
      blockedSourceSlugs: [],
      toolBlockedSourceSlugs: [],
    })
    expect(options.timelineItems.map(item => item.type)).toEqual([
      'source_state_changed',
      'source_state_changed',
      'source_state_changed',
      'source_state_changed',
    ])
    expect(JSON.stringify(options)).not.toContain('secret-value')
  })
})

function loadedSource(config: {
  slug: string
  type: 'api' | 'local' | 'mcp'
  api?: LoadedSource['config']['api']
  local?: LoadedSource['config']['local']
  mcp?: LoadedSource['config']['mcp']
}): LoadedSource {
  return {
    config: {
      id: config.slug,
      name: config.slug,
      slug: config.slug,
      enabled: true,
      provider: config.slug,
      type: config.type,
      api: config.api,
      local: config.local,
      mcp: config.mcp,
      isAuthenticated: true,
      connectionStatus: 'connected',
    },
    guide: null,
    folderPath: `/workspace/sources/${config.slug}`,
    workspaceRootPath: '/workspace',
    workspaceId: 'workspace-a',
  }
}
