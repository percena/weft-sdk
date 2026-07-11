import type {
  PermissionMode,
  RuntimeExtensionCapabilities,
  RuntimeExtensionContext,
  RuntimeHostToolCapabilities,
} from '@weft/runtime-core'

export function hostToolCapabilitiesFromExtensions(
  extensions?: RuntimeExtensionContext,
): RuntimeHostToolCapabilities {
  const sessionTools = extensions?.hostServices?.sessionTools
  if (!sessionTools) {
    return {
      supported: false,
      sessionTools: false,
      workflowTransitions: false,
      browserActions: false,
      metadataWrites: false,
    }
  }

  const workflowTransitions = Boolean(sessionTools.submitPlan)
  const browserActions = Boolean(sessionTools.runBrowserAction)
  const metadataWrites = Boolean(sessionTools.updateSessionMetadata)
  const degraded = !workflowTransitions || !browserActions || !metadataWrites

  return {
    supported: true,
    degraded: degraded || undefined,
    sessionTools: true,
    workflowTransitions,
    browserActions,
    metadataWrites,
    reason: degraded ? 'Host session tool bridge is only partially attached' : undefined,
  }
}

const POLICY_MODES: PermissionMode[] = ['explore', 'ask', 'auto']

/**
 * Options for {@link createStandardExtensionCapabilities}. Defaults reproduce
 * the claude / codex "local producer" shape (a single `strong` gate = native
 * SDK / app-server available, CLI fallback otherwise). The gating flags below
 * are only needed by the flitro "remote server" provider, whose every
 * capability collapses to server availability.
 */
export interface StandardExtensionCapabilitiesOptions {
  /** The "strong runtime" gate: native-sdk / app-server available. */
  strong: boolean
  /** Host extension context; hostTools are derived from it unless overridden. */
  extensions?: RuntimeExtensionContext
  /** `policy.reason` when `!strong`. */
  policyReasonWeak: string
  /** Gate `policy.toolPolicy` on `strong` (flitro). Default: always `true`. */
  gateToolPolicy?: boolean
  sources: {
    /** Emit `sources.degraded = strong` (codex: degraded even when available). */
    degradedWhenStrong?: boolean
    /** Include `sources.credentialGateway` (flitro: `false`). */
    credentialGateway?: boolean
    /** `sources.reason` when `strong` (codex's "accepted but not executed" note). */
    reasonStrong?: string
    /** `sources.reason` when `!strong`. */
    reasonWeak: string
  }
  /** `skills.reason` when `!strong`. */
  skillsReasonWeak: string
  automations: {
    /** Gate `automations.supported` on `strong` (flitro). Default: `true`. */
    gateSupported?: boolean
    /** Gate `automations.eventBus` on `strong` (flitro). Default: `true`. */
    gateEventBus?: boolean
    /** `automations.schedulerHost = strong` (flitro). Default: `false`. */
    schedulerHostWhenStrong?: boolean
    /** Gate `automations.promptAction` on `strong` (flitro). Default: `true`. */
    gatePromptAction?: boolean
    /** `automations.reason` when `!strong`. */
    reasonWeak: string
  }
  /**
   * Emit `degraded` as `undefined` (key omitted) instead of `false` when
   * `strong` (flitro style). Default: emit boolean `false`.
   */
  omitFalseDegraded?: boolean
  /** Override hostTools entirely (flitro inlines them). Default: from extensions. */
  hostTools?: RuntimeHostToolCapabilities
}

/**
 * Build the `extensionCapabilities` block shared by all three providers. The
 * three previously hand-rolled near-identical blocks; this centralises the
 * skeleton (policy/sources/skills/automations/hostTools) while preserving each
 * provider's exact output via the options above.
 */
export function createStandardExtensionCapabilities(
  options: StandardExtensionCapabilitiesOptions,
): RuntimeExtensionCapabilities {
  const { strong } = options
  const degraded = (): boolean | undefined =>
    strong ? (options.omitFalseDegraded ? undefined : false) : true

  return {
    policy: {
      supported: true,
      degraded: degraded(),
      modes: POLICY_MODES,
      approvals: strong,
      toolPolicy: options.gateToolPolicy ? strong : true,
      reason: strong ? undefined : options.policyReasonWeak,
    },
    sources: {
      supported: strong,
      ...(options.sources.degradedWhenStrong ? { degraded: strong } : {}),
      registry: strong,
      mcpTools: strong,
      ...(options.sources.credentialGateway !== undefined
        ? { credentialGateway: options.sources.credentialGateway }
        : {}),
      reason: strong ? options.sources.reasonStrong : options.sources.reasonWeak,
    },
    skills: {
      supported: strong,
      registry: strong,
      activationPlan: strong,
      scopedPolicy: strong,
      reason: strong ? undefined : options.skillsReasonWeak,
    },
    automations: {
      supported: options.automations.gateSupported ? strong : true,
      degraded: degraded(),
      eventBus: options.automations.gateEventBus ? strong : true,
      schedulerHost: options.automations.schedulerHostWhenStrong ? strong : false,
      promptAction: options.automations.gatePromptAction ? strong : true,
      webhookAction: false,
      reason: strong ? undefined : options.automations.reasonWeak,
    },
    hostTools: options.hostTools ?? hostToolCapabilitiesFromExtensions(options.extensions),
  }
}
