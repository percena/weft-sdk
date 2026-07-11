import type { PendingPrompt } from './types.ts'
import type { ExecuteAutomationPromptResult } from './runtime-bridge.ts'
import type { AutomationInputEvent } from './timeline-bridge.ts'

export type AutomationHistoryActionType = 'prompt' | 'webhook' | 'scheduler' | 'metadata'
export type AutomationHistoryStatus = 'success' | 'failed' | 'skipped'

export interface AutomationHistoryRecordInput {
  matcherId: string
  automationName?: string
  sessionId?: string
  actionType: AutomationHistoryActionType
  status: AutomationHistoryStatus
  skipped?: boolean
  attempt?: number
  promptPreview?: string
  error?: string
  timelineItemCount?: number
  metadata?: Record<string, unknown>
}

export interface AutomationHistoryRecord extends AutomationHistoryRecordInput {
  recordId: string
  attempt: number
  timestamp: number
}

export interface AutomationHistoryListFilter {
  matcherId?: string
  sessionId?: string
  status?: AutomationHistoryStatus
  limit?: number
}

export interface AutomationHistoryStore {
  record(input: AutomationHistoryRecordInput): Promise<AutomationHistoryRecord>
  list(filter?: AutomationHistoryListFilter): Promise<AutomationHistoryRecord[]>
  getLastExecuted(matcherId: string): Promise<AutomationHistoryRecord | undefined>
  getSnapshot(): { records: AutomationHistoryRecord[] }
}

export interface InMemoryAutomationHistoryStoreOptions {
  now?: () => number
  maxEntries?: number
}

export function createInMemoryAutomationHistoryStore(
  options: InMemoryAutomationHistoryStoreOptions = {},
): AutomationHistoryStore {
  const now = options.now ?? Date.now
  const maxEntries = options.maxEntries ?? Number.POSITIVE_INFINITY
  const records: AutomationHistoryRecord[] = []

  return {
    async record(input) {
      const record: AutomationHistoryRecord = {
        ...cloneHistoryInput(input),
        recordId: `automation-history:${records.length + 1}`,
        attempt: input.attempt ?? 1,
        timestamp: now(),
      }
      records.push(record)
      while (records.length > maxEntries) records.shift()
      return cloneHistoryRecord(record)
    },

    async list(filter = {}) {
      return filterHistoryRecords(records, filter).map(cloneHistoryRecord)
    },

    async getLastExecuted(matcherId) {
      const record = [...records]
        .reverse()
        .find(candidate => candidate.matcherId === matcherId && candidate.status !== 'skipped')
      return record ? cloneHistoryRecord(record) : undefined
    },

    getSnapshot() {
      return { records: records.map(cloneHistoryRecord) }
    },
  }
}

export function automationHistoryInputForPromptResult(
  prompt: PendingPrompt,
  result: ExecuteAutomationPromptResult,
): AutomationHistoryRecordInput {
  const actionResult = result.timelineItems
    .map(item => item.type === 'automation_action_result' ? item.result : undefined)
    .find(Boolean) as Record<string, unknown> | undefined
  const success = actionResult?.success === true
  const skipped = result.skipped || actionResult?.skipped === true
  const error = typeof actionResult?.reason === 'string' ? actionResult.reason : undefined

  return {
    matcherId: prompt.matcherId ?? prompt.automationName ?? 'automation',
    automationName: prompt.automationName,
    sessionId: prompt.sessionId,
    actionType: 'prompt',
    status: skipped ? 'skipped' : success ? 'success' : 'failed',
    skipped,
    attempt: 1,
    promptPreview: redactAutomationText(prompt.prompt),
    ...(error ? { error: redactAutomationText(error) } : {}),
    timelineItemCount: result.timelineItems.length,
  }
}

function filterHistoryRecords(
  records: AutomationHistoryRecord[],
  filter: AutomationHistoryListFilter,
): AutomationHistoryRecord[] {
  return records
    .filter(record => !filter.matcherId || record.matcherId === filter.matcherId)
    .filter(record => !filter.sessionId || record.sessionId === filter.sessionId)
    .filter(record => !filter.status || record.status === filter.status)
    .slice(0, filter.limit ?? Number.POSITIVE_INFINITY)
}

function cloneHistoryInput(input: AutomationHistoryRecordInput): AutomationHistoryRecordInput {
  return {
    ...input,
    ...(input.metadata ? { metadata: { ...input.metadata } } : {}),
  }
}

function cloneHistoryRecord(record: AutomationHistoryRecord): AutomationHistoryRecord {
  return {
    ...record,
    ...(record.metadata ? { metadata: { ...record.metadata } } : {}),
  }
}

function redactAutomationText(text: string): string {
  return text
    .replace(/(authorization\s*[:=]\s*)(bearer\s+)?[^\s,;]+/gi, (_match, prefix: string, bearer = '') => `${prefix}${bearer}[REDACTED]`)
    .replace(/(token\s*[:=]\s*)[^\s,;]+/gi, (_match, prefix: string) => `${prefix}[REDACTED]`)
    .replace(/(api[_-]?key\s*[:=]\s*)[^\s,;]+/gi, (_match, prefix: string) => `${prefix}[REDACTED]`)
    .replace(/(secret\s*[:=]\s*)[^\s,;]+/gi, (_match, prefix: string) => `${prefix}[REDACTED]`)
}

export interface AutomationScheduleRegistration {
  schedulerId: string
  workspaceId: string
  cron: string
  timezone: string
}

export interface AutomationSchedulerLifecycleReceipt extends AutomationScheduleRegistration {
  state: 'started' | 'stopped'
  timestamp: number
}

export interface AutomationSchedulerTickOptions {
  reason?: string
}

export interface AutomationSchedulerHost {
  start(input: AutomationScheduleRegistration): AutomationSchedulerLifecycleReceipt
  stop(schedulerId: string): AutomationSchedulerLifecycleReceipt | undefined
  tick(schedulerId: string, options?: AutomationSchedulerTickOptions): boolean
  getSnapshot(): { schedules: AutomationScheduleRegistration[] }
}

export interface AutomationSchedulerHostOptions {
  now?: () => number
  publish(event: AutomationInputEvent): void | Promise<void>
}

export function createAutomationSchedulerHost(
  options: AutomationSchedulerHostOptions,
): AutomationSchedulerHost {
  const now = options.now ?? Date.now
  const schedules = new Map<string, AutomationScheduleRegistration>()

  return {
    start(input) {
      const registration = { ...input }
      schedules.set(input.schedulerId, registration)
      return {
        ...registration,
        state: 'started',
        timestamp: now(),
      }
    },

    stop(schedulerId) {
      const registration = schedules.get(schedulerId)
      if (!registration) return undefined
      schedules.delete(schedulerId)
      return {
        ...registration,
        state: 'stopped',
        timestamp: now(),
      }
    },

    tick(schedulerId, tickOptions = {}) {
      const registration = schedules.get(schedulerId)
      if (!registration) return false
      void Promise.resolve(options.publish({
        event: 'SchedulerTick',
        source: 'host',
        sessionId: registration.workspaceId,
        matchValue: registration.schedulerId,
        payload: {
          ...registration,
          ...(tickOptions.reason ? { reason: tickOptions.reason } : {}),
        },
        timestamp: now(),
      }))
      return true
    },

    getSnapshot() {
      return {
        schedules: [...schedules.values()].map(schedule => ({ ...schedule })),
      }
    },
  }
}
