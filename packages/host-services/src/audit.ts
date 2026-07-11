export type HostAuditCategory =
  | 'policy'
  | 'automation'
  | 'session_tool'
  | 'tool_output'
  | 'privileged_execution'
  | 'config'
  | 'metadata'
  | 'messaging'
  | 'notification'

export interface HostAuditActor {
  type: 'user' | 'automation' | 'scheduler' | 'host' | 'remote' | 'system'
  id?: string
}

export interface HostAuditEntryInput {
  category: HostAuditCategory
  action: string
  sessionId?: string
  actor?: HostAuditActor
  redactedSummary?: string
  metadata?: Record<string, unknown>
}

export interface HostAuditEntry extends HostAuditEntryInput {
  auditId: string
  seq: number
  timestamp: number
}

export interface HostAuditAppendReceipt {
  auditId: string
  seq: number
  timestamp: number
  entry: HostAuditEntry
}

export interface HostAuditListFilter {
  sessionId?: string
  category?: HostAuditCategory
  limit?: number
}

export interface InMemoryAuditStore {
  append(input: HostAuditEntryInput): Promise<HostAuditAppendReceipt>
  list(filter?: HostAuditListFilter): Promise<HostAuditEntry[]>
  getSnapshot(): { entries: HostAuditEntry[] }
}

export interface InMemoryAuditStoreOptions {
  now?: () => number
}

export function createInMemoryAuditStore(
  options: InMemoryAuditStoreOptions = {},
): InMemoryAuditStore {
  const now = options.now ?? Date.now
  const entries: HostAuditEntry[] = []

  return {
    async append(input) {
      const seq = entries.length + 1
      const entry: HostAuditEntry = {
        ...cloneAuditEntryInput(input),
        auditId: `audit:${seq}`,
        seq,
        timestamp: now(),
      }
      entries.push(entry)
      return {
        auditId: entry.auditId,
        seq: entry.seq,
        timestamp: entry.timestamp,
        entry: cloneAuditEntry(entry),
      }
    },

    async list(filter = {}) {
      return filterAuditEntries(entries, filter).map(cloneAuditEntry)
    },

    getSnapshot() {
      return { entries: entries.map(cloneAuditEntry) }
    },
  }
}

function cloneAuditEntryInput(input: HostAuditEntryInput): HostAuditEntryInput {
  return {
    ...input,
    ...(input.actor ? { actor: { ...input.actor } } : {}),
    ...(input.metadata ? { metadata: { ...input.metadata } } : {}),
  }
}

function cloneAuditEntry(entry: HostAuditEntry): HostAuditEntry {
  return {
    ...entry,
    ...(entry.actor ? { actor: { ...entry.actor } } : {}),
    ...(entry.metadata ? { metadata: { ...entry.metadata } } : {}),
  }
}

function filterAuditEntries(entries: HostAuditEntry[], filter: HostAuditListFilter): HostAuditEntry[] {
  return entries
    .filter(entry => !filter.sessionId || entry.sessionId === filter.sessionId)
    .filter(entry => !filter.category || entry.category === filter.category)
    .slice(0, filter.limit ?? Number.POSITIVE_INFINITY)
}
