import { redactSecrets } from './shared-utils.ts'

export interface ToolOutputArtifactWriteInput {
  artifactRef: string
  sessionId?: string
  toolName: string
  contentType: string
  text: string
  metadata?: Record<string, unknown>
}

export interface ToolOutputArtifactReceipt {
  artifactRef: string
  sessionId?: string
  toolName: string
  contentType: string
  byteLength: number
  redacted: boolean
  createdAt: number
  metadata?: Record<string, unknown>
}

export interface ToolOutputArtifactRecord extends ToolOutputArtifactReceipt {
  text: string
}

export interface ToolOutputArtifactListFilter {
  sessionId?: string
  toolName?: string
  limit?: number
}

export interface InMemoryArtifactStore {
  write(input: ToolOutputArtifactWriteInput): Promise<ToolOutputArtifactReceipt>
  read(artifactRef: string): Promise<ToolOutputArtifactRecord | undefined>
  list(filter?: ToolOutputArtifactListFilter): Promise<ToolOutputArtifactReceipt[]>
  getSnapshot(): { artifacts: ToolOutputArtifactRecord[] }
}

export interface InMemoryArtifactStoreOptions {
  now?: () => number
}

export function createInMemoryArtifactStore(
  options: InMemoryArtifactStoreOptions = {},
): InMemoryArtifactStore {
  const now = options.now ?? Date.now
  const artifacts = new Map<string, ToolOutputArtifactRecord>()

  return {
    async write(input) {
      const redaction = redactSecrets(input.text)
      const record: ToolOutputArtifactRecord = {
        artifactRef: input.artifactRef,
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        toolName: input.toolName,
        contentType: input.contentType,
        text: redaction.text,
        byteLength: Buffer.byteLength(redaction.text, 'utf8'),
        redacted: redaction.redacted,
        createdAt: now(),
        ...(input.metadata ? { metadata: { ...input.metadata } } : {}),
      }
      artifacts.set(record.artifactRef, record)
      return artifactReceipt(record)
    },

    async read(artifactRef) {
      const record = artifacts.get(artifactRef)
      return record ? cloneArtifactRecord(record) : undefined
    },

    async list(filter = {}) {
      return filterArtifactRecords([...artifacts.values()], filter).map(artifactReceipt)
    },

    getSnapshot() {
      return {
        artifacts: [...artifacts.values()].map(cloneArtifactRecord),
      }
    },
  }
}

function filterArtifactRecords(
  records: ToolOutputArtifactRecord[],
  filter: ToolOutputArtifactListFilter,
): ToolOutputArtifactRecord[] {
  return records
    .filter(record => !filter.sessionId || record.sessionId === filter.sessionId)
    .filter(record => !filter.toolName || record.toolName === filter.toolName)
    .slice(0, filter.limit ?? Number.POSITIVE_INFINITY)
}

function artifactReceipt(record: ToolOutputArtifactRecord): ToolOutputArtifactReceipt {
  return {
    artifactRef: record.artifactRef,
    ...(record.sessionId ? { sessionId: record.sessionId } : {}),
    toolName: record.toolName,
    contentType: record.contentType,
    byteLength: record.byteLength,
    redacted: record.redacted,
    createdAt: record.createdAt,
    ...(record.metadata ? { metadata: { ...record.metadata } } : {}),
  }
}

function cloneArtifactRecord(record: ToolOutputArtifactRecord): ToolOutputArtifactRecord {
  return {
    ...record,
    ...(record.metadata ? { metadata: { ...record.metadata } } : {}),
  }
}
