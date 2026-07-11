/**
 * Weft Automations - Public API
 *
 * Slim barrel file that re-exports from decomposed modules:
 * - types.ts: All type definitions
 * - validation.ts: Config validation functions
 * - sdk-bridge.ts: SDK environment variable building
 * - utils.ts: Shared utilities (toSnakeCase, expandEnvVars, etc.)
 * - automation-system.ts: AutomationSystem facade (main entry point)
 * - event-bus.ts: WorkspaceEventBus
 * - handlers/: PromptHandler, WebhookHandler, EventLogHandler
 */

// ============================================================================
// Types
// ============================================================================

export type {
  AppEvent,
  AgentEvent,
  AutomationEvent,
  PromptAction,
  WebhookAction,
  WebhookHttpMethod,
  WebhookBodyFormat,
  WebhookAuth,
  AutomationAction,
  AutomationMatcher,
  AutomationsConfig,
  PromptReferences,
  PromptActionResult,
  WebhookActionResult,
  ActionExecutionResult,
  PendingPrompt,
  AutomationResult,
  AutomationsValidationResult,
  SdkAutomationInput,
  SdkAutomationCallback,
  SdkAutomationCallbackMatcher,
  SessionMetadataSnapshot,
  TimeCondition,
  StateCondition,
  LogicalCondition,
  AutomationCondition,
} from './types.ts';

export { APP_EVENTS, AGENT_EVENTS } from './types.ts';

// ============================================================================
// Validation
// ============================================================================

export {
  createAutomationsConfigDoctorReport,
  validateAutomationsConfig,
  validateAutomationsContent,
  validateAutomations,
  type AutomationsConfigDoctorReport,
} from './validation.ts';

// ============================================================================
// SDK Bridge
// ============================================================================

export { buildEnvFromSdkInput } from './sdk-bridge.ts';

// ============================================================================
// Utilities
// ============================================================================

export { parsePromptReferences } from './utils.ts';

// Runtime bridge
export {
  createAutomationRuntimeGuard,
  executeAutomationPrompt,
  type AutomationDispatchKey,
  type AutomationRuntimeGuard,
  type ExecuteAutomationPromptOptions,
  type ExecuteAutomationPromptResult,
} from './runtime-bridge.ts';

export {
  createAutomationTimelineBridge,
  projectTimelineEnvelopeToAutomationInput,
  type AutomationInputEvent,
  type AutomationInputEventSource,
  type AutomationTimelineBridge,
  type CreateAutomationTimelineBridgeOptions,
} from './timeline-bridge.ts';

export {
  createRuntimeAutomationBridge,
  type CreateRuntimeAutomationBridgeOptions,
  type RuntimeAutomationBridge,
} from './runtime-automation-bridge.ts';

export {
  automationHistoryInputForPromptResult,
  createAutomationSchedulerHost,
  createInMemoryAutomationHistoryStore,
  type AutomationHistoryActionType,
  type AutomationHistoryListFilter,
  type AutomationHistoryRecord,
  type AutomationHistoryRecordInput,
  type AutomationHistoryStatus,
  type AutomationHistoryStore,
  type AutomationScheduleRegistration,
  type AutomationSchedulerHost,
  type AutomationSchedulerHostOptions,
  type AutomationSchedulerLifecycleReceipt,
  type AutomationSchedulerTickOptions,
} from './host-contracts.ts';

// ============================================================================
// Re-exports from sub-modules
// ============================================================================

// Event logger
export { AutomationEventLogger, type LoggedAutomationEvent, type LoggedAutomationEventInput } from './event-logger.ts';

// Schemas
export { AutomationsConfigSchema, AutomationConditionSchema, TimeConditionSchema, StateConditionSchema, zodErrorToIssues, VALID_EVENTS } from './schemas.ts';

// Condition evaluator
export { evaluateConditions, type ConditionContext } from './conditions.ts';

// Security utilities
export { sanitizeForShell } from './security.ts';

// Webhook execution utilities
export { executeWebhookRequest, executeWithRetry, createWebhookHistoryEntry, createPromptHistoryEntry, type ExecuteWebhookOptions, type RetryConfig } from './webhook-utils.ts';

// Retry scheduler
export { RetryScheduler, type RetryQueueEntry, type RetrySchedulerOptions } from './retry-scheduler.ts';

// Config constants
export { AUTOMATIONS_CONFIG_FILE, AUTOMATIONS_HISTORY_FILE, AUTOMATIONS_RETRY_QUEUE_FILE, HISTORY_FIELD_MAX_LENGTH, AUTOMATION_HISTORY_MAX_RUNS_PER_MATCHER, AUTOMATION_HISTORY_MAX_ENTRIES } from './constants.ts';

// History store
export { appendAutomationHistoryEntry, compactAutomationHistory, compactAutomationHistorySync } from './history-store.ts';

// Config path resolution
export { resolveAutomationsConfigPath, generateShortId } from './resolve-config-path.ts';

// Config I/O
export {
  loadAutomationsConfig,
  saveAutomationsConfig,
  type LoadAutomationsConfigResult,
  type SaveAutomationsConfigResult,
} from './config-io.ts';

// Cron matching
export { matchesCron } from './cron-matcher.ts';

// Event Bus
export {
  WorkspaceEventBus,
  type EventBus,
  type EventPayloadMap,
  type BaseEventPayload,
  type LabelEventPayload,
  type PermissionModeChangePayload,
  type FlagChangePayload,
  type SessionStatusChangePayload,
  type SchedulerTickPayload,
  type LabelConfigChangePayload,
  type GenericEventPayload,
  type EventHandler,
  type AnyEventHandler,
} from './event-bus.ts';

// AutomationSystem facade
export {
  AutomationSystem,
  type AutomationSystemOptions,
  type SessionMetadataSnapshot as AutomationSystemMetadataSnapshot,
} from './automation-system.ts';

// Handlers
export {
  PromptHandler,
  EventLogHandler,
  WebhookHandler,
  type AutomationHandler,
  type PromptHandlerOptions,
  type EventLogHandlerOptions,
  type WebhookHandlerOptions,
  type AutomationsConfigProvider,
} from './handlers/index.ts';

// Auto-label evaluator
export { evaluateAutoLabels } from './labels/auto-label-evaluator.ts';
export { normalizeNumberValue } from './labels/auto-label-normalize.ts';
export { validateAutoLabelPattern } from './labels/auto-label-validation.ts';
export type { AutoLabelRule, AutoLabelConfig, AutoLabelMatch } from './labels/auto-label-types.ts';
export type { AutoLabelRuleValidation } from './labels/auto-label-validation.ts';

// Label utilities
export { extractLabelId } from './labels/values.ts';
