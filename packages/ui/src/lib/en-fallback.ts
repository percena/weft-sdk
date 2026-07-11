/**
 * English fallback translations for UI components.
 *
 * Used by:
 * - `TurnCard.tsx` `t()` wrapper — when i18next is uninitialized or has no resource for a key
 * - `apps/chat-playground/src/i18n-init.ts` — as the primary `en` resource bundle
 *
 * Single source of truth — add new keys here, both consumers stay synchronized.
 */
export const EN_FALLBACK: Record<string, string> = {
  // TurnCard
  'turnCard.processing': 'Processing',
  'turnCard.responding': 'Responding',
  'turnCard.stepsCompleted': 'Steps completed',
  'turnCard.starting': 'Starting',
  'turnCard.errorCount': '{{count}} errors',
  // Common
  'common.error': 'Error',
  'common.viewFullscreen': 'View fullscreen',
  'common.copy': 'Copy',
  'common.copied': 'Copied',
  'common.editing': 'Editing',
  'common.cancel': 'Cancel',
  'common.done': 'Done',
  'common.failed': 'Failed',
  'common.dismiss': 'Dismiss',
  'common.retry': 'Retry',
  // Chat
  'chat.branchOptions': 'Branch options',
  'chat.branch': 'Branch',
  'chat.branchFromThisMessage': 'Branch from this message',
  'chat.branchFromThisMessageDescription': 'Create a new conversation branch starting from this message',
  'chat.contextBadge': 'Context',
  'chat.queuedBadge': 'Queued',
  'chat.viewFileChanges': 'View file changes',
  'chat.viewTurnDetails': 'View turn details',
  // Plan
  'plan.acceptPlan': 'Accept plan',
  'plan.accept': 'Accept',
  'plan.executeImmediately': 'Execute immediately',
  'plan.acceptAndCompact': 'Accept & compact',
  'plan.worksForComplex': 'Works well for complex multi-step plans',
  'plan.acceptAndSendFollowups': 'Accept & send follow-ups',
}