import { describe, expect, test } from 'vitest'

import {
  createInMemoryArtifactStore,
  createInMemoryAuditStore,
  createInMemoryHostUtilityToolRegistry,
  createInMemoryNotificationHost,
  createInMemorySessionToolBridge,
  createMessagingBindingStore,
  createMessagingAccessPolicy,
  createPrivilegedExecutionBroker,
  createSecondaryLlmCallPolicy,
  createSourceAuthoringPlan,
  createToolOutputPolicy,
  expandWebhookTemplate,
  scrubLocalMcpEnvironment,
} from '@weft/host-services'
import { invokeSessionTool } from '@weft/runtime-core'
import type { TimelineEnvelope } from '@weft/timeline'

describe('Host services — privileged execution and tool output governance', () => {
  test('privileged execution requests require allowlist, TTL, and command hash matching', () => {
    const auditEvents: unknown[] = []
    const broker = createPrivilegedExecutionBroker({
      now: () => 1_000,
      audit: event => auditEvents.push(event),
    })

    const request = broker.createRequest({
      requestId: 'priv-1',
      sessionId: 'session-a',
      command: 'brew install --cask visual-studio-code',
      reason: 'Install a desktop dependency',
      impact: 'Modifies /Applications',
      approvalTtlMs: 5_000,
    })

    expect(request.policyAllowed).toBe(true)
    expect(request.commandHash).toHaveLength(64)

    expect(broker.resolveApproval('priv-1', true, {
      expectedCommandHash: 'wrong-hash',
      now: 2_000,
    })).toMatchObject({
      ok: false,
      reason: 'command_hash_mismatch',
    })

    const blocked = broker.createRequest({
      requestId: 'priv-2',
      sessionId: 'session-a',
      command: 'sudo rm -rf /',
      approvalTtlMs: 5_000,
    })
    expect(blocked.policyAllowed).toBe(false)
    expect(broker.resolveApproval('priv-2', true, {
      expectedCommandHash: blocked.commandHash,
      now: 2_000,
    })).toMatchObject({
      ok: false,
      reason: 'blocked_by_policy',
    })

    const expired = broker.createRequest({
      requestId: 'priv-3',
      sessionId: 'session-a',
      command: 'brew upgrade --cask raycast',
      approvalTtlMs: 500,
    })
    expect(broker.resolveApproval('priv-3', true, {
      expectedCommandHash: expired.commandHash,
      now: 2_000,
    })).toMatchObject({
      ok: false,
      reason: 'expired',
    })

    const allowed = broker.createRequest({
      requestId: 'priv-4',
      sessionId: 'session-a',
      command: 'installer -pkg /tmp/app.pkg -target /',
      approvalTtlMs: 5_000,
    })
    expect(broker.resolveApproval('priv-4', true, {
      expectedCommandHash: allowed.commandHash,
      now: 2_000,
    })).toMatchObject({
      ok: true,
      request: {
        requestId: 'priv-4',
        commandHash: allowed.commandHash,
      },
    })
    expect(JSON.stringify(auditEvents)).not.toContain('sudo rm')
    expect(auditEvents).toHaveLength(8)
  })

  test('tool output policy redacts, truncates, and produces artifact receipts', () => {
    const policy = createToolOutputPolicy({
      maxInlineBytes: 20,
      artifactRef: input => `artifact://${input.callId}`,
      summarizer: input => `summary:${input.text.slice(0, 12)}`,
    })

    const small = policy.process({
      callId: 'tool-small',
      toolName: 'source_fetch',
      text: 'short result',
    })
    expect(small).toMatchObject({
      action: 'inline',
      redacted: false,
      truncated: false,
      inlineText: 'short result',
    })

    const large = policy.process({
      callId: 'tool-large',
      toolName: 'source_fetch',
      text: `token=secret-value\n${'x'.repeat(64)}`,
      intent: 'inspect source response',
    })
    expect(large).toMatchObject({
      action: 'artifact',
      artifactRef: 'artifact://tool-large',
      redacted: true,
      truncated: true,
      summary: 'summary:token=[REDAC',
      intent: 'inspect source response',
    })
    expect(JSON.stringify(large)).not.toContain('secret-value')
  })

  test('source authoring plan records reusable source and browser fallback decisions', () => {
    const reusable = createSourceAuthoringPlan({
      serviceName: 'Linear',
      workspaceId: 'workspace-a',
      purpose: 'Track engineering issues every morning',
      repeatable: true,
      structuredAccess: true,
      authReliability: 'stable',
    })

    expect(reusable.recommendedPath).toBe('source')
    expect(reusable.source.slug).toBe('linear')
    expect(reusable.validationSteps).toEqual(expect.arrayContaining([
      'validate_config',
      'test_connection',
      'verify_auth',
      'write_guide',
    ]))

    const fallback = createSourceAuthoringPlan({
      serviceName: 'Gmail Admin UI',
      workspaceId: 'workspace-a',
      purpose: 'One-off export behind brittle auth',
      repeatable: false,
      structuredAccess: false,
      authReliability: 'brittle',
      uiOnly: true,
    })

    expect(fallback.recommendedPath).toBe('browser-fallback')
    expect(fallback.browserFallbackDecision).toMatchObject({
      reason: 'one_off_or_ui_only',
      reusableSourceLater: true,
    })
  })

  test('webhook template expansion emits redacted receipts without leaking secrets', () => {
    const receipt = expandWebhookTemplate({
      template: 'POST ${WEBHOOK_URL} token=${WEBHOOK_TOKEN} event=$EVENT missing=$MISSING',
      variables: {
        EVENT: 'SessionStatusChange',
      },
      secrets: {
        WEBHOOK_URL: 'https://hooks.example.test/T000/B000/secret',
        WEBHOOK_TOKEN: 'secret-token',
      },
    })

    expect(receipt.expanded).toContain('secret-token')
    expect(receipt.redactedPreview).toContain('[REDACTED]')
    expect(receipt.redactedPreview).not.toContain('secret-token')
    expect(receipt.missingVariables).toEqual(['MISSING'])
    expect(receipt.variables.find(variable => variable.name === 'WEBHOOK_TOKEN')).toMatchObject({
      source: 'secret',
      redacted: true,
    })
  })

  test('messaging access policy separates owners, allowed senders, and pending remote commands', () => {
    const policy = createMessagingAccessPolicy({
      owners: ['owner-1'],
      allowedSenders: ['teammate-1'],
      pendingSenders: ['pending-1'],
    })

    expect(policy.authorize({
      actorId: 'owner-1',
      channel: 'telegram',
      action: 'send_command',
    })).toMatchObject({
      decision: 'allow',
      commandOrigin: { type: 'remote', channel: 'telegram', actorId: 'owner-1' },
    })

    expect(policy.authorize({
      actorId: 'pending-1',
      channel: 'telegram',
      action: 'send_command',
    })).toMatchObject({
      decision: 'ask',
      reason: 'sender_pending_approval',
    })

    expect(policy.authorize({
      actorId: 'stranger',
      channel: 'telegram',
      action: 'bind_topic',
    })).toMatchObject({
      decision: 'deny',
      reason: 'sender_not_allowed',
    })
  })

  test('in-memory session tool bridge implements host callbacks with inspectable state', async () => {
    const timeline: TimelineEnvelope[] = []
    const host = createInMemorySessionToolBridge({
      now: () => 2_000,
      nextSessionId: () => 'session-child',
    })

    const metadataReceipt = await invokeSessionTool({
      sessionId: 'session-a',
      toolName: 'updateSessionMetadata',
      request: {
        sessionId: 'session-a',
        labels: ['triage', 'urgent'],
        status: 'active',
        topic: 'Runtime wiring',
      },
      bridge: host.bridge,
      appendTimeline: item => appendHostTimeline(timeline, item),
    })
    expect(metadataReceipt.ok).toBe(true)
    expect(metadataReceipt.result).toMatchObject({
      sessionId: 'session-a',
      labels: ['triage', 'urgent'],
      status: 'active',
      topic: 'Runtime wiring',
    })

    await invokeSessionTool({
      sessionId: 'session-a',
      toolName: 'submitPlan',
      request: {
        sessionId: 'session-a',
        planRef: 'plans/runtime-host.md',
        origin: { type: 'user', id: 'accept-plan' },
      },
      bridge: host.bridge,
      appendTimeline: item => appendHostTimeline(timeline, item),
    })

    const browserReceipt = await invokeSessionTool({
      sessionId: 'session-a',
      toolName: 'runBrowserAction',
      request: {
        sessionId: 'session-a',
        action: 'open',
        input: { url: 'https://example.test' },
      },
      bridge: host.bridge,
      appendTimeline: item => appendHostTimeline(timeline, item),
    })
    expect(browserReceipt.result).toMatchObject({
      ok: true,
      result: {
        action: 'open',
        input: { url: 'https://example.test' },
        recordedAt: 2_000,
      },
    })

    const spawnReceipt = await invokeSessionTool({
      sessionId: 'session-a',
      toolName: 'spawnSession',
      request: {
        parentSessionId: 'session-a',
        prompt: 'Follow up on runtime wiring',
        commandOrigin: { type: 'automation', id: 'daily-review' },
      },
      bridge: host.bridge,
      appendTimeline: item => appendHostTimeline(timeline, item),
    })
    expect(spawnReceipt.result).toEqual({ sessionId: 'session-child' })

    const messageReceipt = await invokeSessionTool({
      sessionId: 'session-a',
      toolName: 'sendSessionMessage',
      request: {
        sessionId: 'session-child',
        message: 'Check host callback state',
        commandOrigin: { type: 'host', id: 'bridge-test' },
      },
      bridge: host.bridge,
      appendTimeline: item => appendHostTimeline(timeline, item),
    })
    expect(messageReceipt.result).toMatchObject({ ok: true, commandId: 'message:1' })

    const listReceipt = await invokeSessionTool({
      sessionId: 'session-a',
      toolName: 'listSessions',
      request: {
        labels: ['triage'],
        limit: 5,
      },
      bridge: host.bridge,
      appendTimeline: item => appendHostTimeline(timeline, item),
    })
    expect(listReceipt.result).toEqual({
      sessions: [
        {
          sessionId: 'session-a',
          labels: ['triage', 'urgent'],
          status: 'active',
          topic: 'Runtime wiring',
        },
      ],
    })

    expect(host.getSnapshot()).toMatchObject({
      plans: [{ sessionId: 'session-a', planRef: 'plans/runtime-host.md', submittedAt: 2_000 }],
      browserActions: [{ sessionId: 'session-a', action: 'open', recordedAt: 2_000 }],
      messages: [{ sessionId: 'session-child', message: 'Check host callback state', commandId: 'message:1' }],
    })
    expect(timeline.filter(item => item.item.type === 'host_state_changed')).toHaveLength(12)
  })

  test('host audit and artifact stores persist redacted receipts without leaking secrets', async () => {
    const audit = createInMemoryAuditStore({ now: () => 3_000 })
    const artifactStore = createInMemoryArtifactStore({ now: () => 3_000 })

    const auditReceipt = await audit.append({
      category: 'tool_output',
      sessionId: 'session-a',
      action: 'artifact_created',
      actor: { type: 'host', id: 'artifact-store' },
      redactedSummary: 'stored large output',
      metadata: { artifactRef: 'artifact://tool-large' },
    })

    const artifactReceipt = await artifactStore.write({
      artifactRef: 'artifact://tool-large',
      sessionId: 'session-a',
      toolName: 'source_fetch',
      contentType: 'text/plain',
      text: `Authorization: Bearer secret-value\n${'x'.repeat(80)}`,
      metadata: { intent: 'inspect source response' },
    })

    expect(auditReceipt).toMatchObject({
      seq: 1,
      timestamp: 3_000,
      entry: {
        category: 'tool_output',
        sessionId: 'session-a',
        action: 'artifact_created',
      },
    })
    expect(artifactReceipt).toMatchObject({
      artifactRef: 'artifact://tool-large',
      sessionId: 'session-a',
      toolName: 'source_fetch',
      byteLength: expect.any(Number),
      redacted: true,
      createdAt: 3_000,
    })
    expect(JSON.stringify(artifactReceipt)).not.toContain('secret-value')

    const loaded = await artifactStore.read('artifact://tool-large')
    expect(loaded?.text).toContain('[REDACTED]')
    expect(loaded?.text).not.toContain('secret-value')
    expect(await audit.list({ sessionId: 'session-a' })).toHaveLength(1)
    expect(await artifactStore.list({ sessionId: 'session-a' })).toHaveLength(1)
  })

  test('notification host records channel routing and redacts secret content', async () => {
    const host = createInMemoryNotificationHost({ now: () => 4_000 })

    const receipt = await host.notify({
      sessionId: 'session-a',
      topicId: 'topic-runtime',
      channels: ['desktop', 'telegram'],
      title: 'Runtime ready',
      body: 'token=secret-value completed',
      severity: 'info',
      origin: { type: 'automation', id: 'daily-review' },
    })

    expect(receipt).toMatchObject({
      notificationId: 'notification:1',
      deliveredChannels: ['desktop', 'telegram'],
      redacted: true,
      timestamp: 4_000,
    })
    expect(JSON.stringify(receipt)).not.toContain('secret-value')
    expect(host.getSnapshot().notifications[0]).toMatchObject({
      notificationId: 'notification:1',
      bodyPreview: 'token=[REDACTED] completed',
    })
  })

  test('messaging binding store binds topics without mixing them into provider session ids', async () => {
    const store = createMessagingBindingStore({ now: () => 5_000 })

    await store.bindTopic({
      bindingId: 'binding-1',
      sessionId: 'session-a',
      channel: 'telegram',
      topicId: 'topic-123',
      actorId: 'owner-1',
    })
    await store.bindTopic({
      bindingId: 'binding-2',
      sessionId: 'session-b',
      channel: 'lark',
      topicId: 'topic-999',
      actorId: 'owner-1',
    })

    expect(await store.resolveTopic({
      channel: 'telegram',
      topicId: 'topic-123',
    })).toMatchObject({
      bindingId: 'binding-1',
      sessionId: 'session-a',
      channel: 'telegram',
      topicId: 'topic-123',
      createdAt: 5_000,
      updatedAt: 5_000,
    })
    expect(await store.listBindings({ sessionId: 'session-a' })).toHaveLength(1)
    expect(await store.unbindTopic('binding-1', { actorId: 'owner-1' })).toMatchObject({
      ok: true,
      bindingId: 'binding-1',
    })
    expect(await store.resolveTopic({ channel: 'telegram', topicId: 'topic-123' })).toBeUndefined()
  })

  test('local MCP environment scrubber removes credential-bearing values and reports removed keys', () => {
    const result = scrubLocalMcpEnvironment({
      PATH: '/usr/bin',
      GITHUB_TOKEN: 'test-redacted-token',
      ANTHROPIC_API_KEY: 'test-redacted-key',
      MCP_SERVER_URL: 'http://localhost:3333',
      BASIC_AUTH: 'test-redacted-auth',
    })

    expect(result.env).toEqual({
      PATH: '/usr/bin',
      MCP_SERVER_URL: 'http://localhost:3333',
    })
    expect(result.removedKeys).toEqual(['ANTHROPIC_API_KEY', 'BASIC_AUTH', 'GITHUB_TOKEN'])
    expect(result.redactedPreview).toMatchObject({
      GITHUB_TOKEN: '[REDACTED]',
      ANTHROPIC_API_KEY: '[REDACTED]',
      BASIC_AUTH: '[REDACTED]',
    })
    expect(JSON.stringify(result)).not.toContain('test-redacted')
  })

  test('host utility registry executes sandboxed tools with policy and output receipts', async () => {
    const registry = createInMemoryHostUtilityToolRegistry({
      now: () => 10_000,
      outputPolicy: createToolOutputPolicy({
        maxInlineBytes: 16,
        artifactRef: input => `artifact://${input.callId}`,
      }),
    })

    registry.register({
      descriptor: {
        name: 'transform_data',
        category: 'sandbox',
        schemaVersion: '1',
        featureFlags: ['host-utility'],
        safeMode: true,
        readOnly: true,
        runtimeSupport: {
          claude: 'supported',
          codex: 'supported',
          mcp: 'degraded',
          cli: 'unsupported',
        },
        sandboxProfile: {
          filesystem: 'read-only',
          network: 'none',
          allowedRuntimes: ['node'],
          timeoutMs: 5_000,
          envScrubbedKeys: ['GITHUB_TOKEN'],
          artifactWriteRoot: '/tmp/weft-artifacts',
        },
      },
      async handler(input) {
        return {
          text: `token=secret-value\n${JSON.stringify(input)}`,
          exitStatus: 'success',
        }
      },
    })

    const receipt = await registry.execute({
      toolName: 'transform_data',
      callId: 'utility-1',
      input: { rows: [1, 2, 3] },
      commandOrigin: { type: 'host', id: 'utility-test' },
      policyDecision: {
        decision: 'allow',
        reason: 'read-only sandbox tool',
      },
    })

    expect(receipt).toMatchObject({
      toolName: 'transform_data',
      callId: 'utility-1',
      executionMode: 'host-service',
      startedAt: 10_000,
      finishedAt: 10_000,
      durationMs: 0,
      exitStatus: 'success',
      policyDecision: {
        decision: 'allow',
        reason: 'read-only sandbox tool',
      },
      sandboxProfile: {
        filesystem: 'read-only',
        network: 'none',
        envScrubbedKeys: ['GITHUB_TOKEN'],
      },
      output: {
        action: 'artifact',
        artifactRef: 'artifact://utility-1',
        redacted: true,
        truncated: true,
      },
    })
    expect(receipt.inputDigest).toMatch(/^sha256:/)
    expect(JSON.stringify(receipt)).not.toContain('secret-value')
    expect(registry.capabilityReport().tools[0]).toMatchObject({
      name: 'transform_data',
      runtimeSupport: { cli: 'unsupported' },
    })
  })

  test('secondary LLM call policy enforces model, size, and attachment limits', () => {
    const policy = createSecondaryLlmCallPolicy({
      allowedModels: ['gpt-5.5-mini'],
      maxInputBytes: 32,
      maxOutputBytes: 64,
      allowedAttachmentRoots: ['/tmp/weft-artifacts'],
    })

    expect(policy.authorize({
      model: 'gpt-5.5-mini',
      prompt: 'summarize',
      maxOutputBytes: 32,
      attachments: ['/tmp/weft-artifacts/result.txt'],
    })).toMatchObject({
      decision: 'allow',
      model: 'gpt-5.5-mini',
    })
    expect(policy.authorize({
      model: 'unknown-model',
      prompt: 'summarize',
    })).toMatchObject({
      decision: 'deny',
      reason: 'model_not_allowed',
    })
    expect(policy.authorize({
      model: 'gpt-5.5-mini',
      prompt: 'x'.repeat(64),
    })).toMatchObject({
      decision: 'deny',
      reason: 'input_too_large',
    })
    expect(policy.authorize({
      model: 'gpt-5.5-mini',
      prompt: 'summarize',
      attachments: ['/home/user/.ssh/id_rsa'],
    })).toMatchObject({
      decision: 'deny',
      reason: 'attachment_path_not_allowed',
    })
  })
})

function appendHostTimeline(timeline: TimelineEnvelope[], item: TimelineEnvelope['item']): TimelineEnvelope {
  const envelope: TimelineEnvelope = {
    sessionId: 'session-a',
    provider: 'host',
    epoch: 'host-services-test',
    seq: timeline.length + 1,
    timestamp: 2_000 + timeline.length,
    item,
  }
  timeline.push(envelope)
  return envelope
}
