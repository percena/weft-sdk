import type { MessagingChannel } from './messaging.ts'

export interface TopicBindingInput {
  bindingId: string
  sessionId: string
  channel: MessagingChannel
  topicId: string
  actorId?: string
  metadata?: Record<string, unknown>
}

export interface TopicBinding {
  bindingId: string
  sessionId: string
  channel: MessagingChannel
  topicId: string
  actorId?: string
  createdAt: number
  updatedAt: number
  metadata?: Record<string, unknown>
}

export interface TopicBindingLookup {
  channel: MessagingChannel
  topicId: string
}

export interface TopicBindingListFilter {
  sessionId?: string
  channel?: MessagingChannel
}

export interface TopicUnbindOptions {
  actorId?: string
}

export type TopicUnbindReceipt =
  | { ok: true; bindingId: string; unboundAt: number; actorId?: string }
  | { ok: false; bindingId: string; reason: 'not_found' }

export interface MessagingBindingStore {
  bindTopic(input: TopicBindingInput): Promise<TopicBinding>
  resolveTopic(lookup: TopicBindingLookup): Promise<TopicBinding | undefined>
  listBindings(filter?: TopicBindingListFilter): Promise<TopicBinding[]>
  unbindTopic(bindingId: string, options?: TopicUnbindOptions): Promise<TopicUnbindReceipt>
  getSnapshot(): { bindings: TopicBinding[] }
}

export interface MessagingBindingStoreOptions {
  now?: () => number
}

export function createMessagingBindingStore(
  options: MessagingBindingStoreOptions = {},
): MessagingBindingStore {
  const now = options.now ?? Date.now
  const bindings = new Map<string, TopicBinding>()

  return {
    async bindTopic(input) {
      const timestamp = now()
      const existing = bindings.get(input.bindingId)
      const binding: TopicBinding = {
        bindingId: input.bindingId,
        sessionId: input.sessionId,
        channel: input.channel,
        topicId: input.topicId,
        ...(input.actorId ? { actorId: input.actorId } : existing?.actorId ? { actorId: existing.actorId } : {}),
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
        ...(input.metadata ? { metadata: { ...input.metadata } } : existing?.metadata ? { metadata: { ...existing.metadata } } : {}),
      }
      bindings.set(binding.bindingId, binding)
      return cloneTopicBinding(binding)
    },

    async resolveTopic(lookup) {
      const binding = [...bindings.values()].find(candidate =>
        candidate.channel === lookup.channel && candidate.topicId === lookup.topicId)
      return binding ? cloneTopicBinding(binding) : undefined
    },

    async listBindings(filter = {}) {
      return [...bindings.values()]
        .filter(binding => !filter.sessionId || binding.sessionId === filter.sessionId)
        .filter(binding => !filter.channel || binding.channel === filter.channel)
        .map(cloneTopicBinding)
    },

    async unbindTopic(bindingId, unbindOptions = {}) {
      if (!bindings.has(bindingId)) return { ok: false, bindingId, reason: 'not_found' }
      bindings.delete(bindingId)
      return {
        ok: true,
        bindingId,
        unboundAt: now(),
        ...(unbindOptions.actorId ? { actorId: unbindOptions.actorId } : {}),
      }
    },

    getSnapshot() {
      return { bindings: [...bindings.values()].map(cloneTopicBinding) }
    },
  }
}

function cloneTopicBinding(binding: TopicBinding): TopicBinding {
  return {
    ...binding,
    ...(binding.metadata ? { metadata: { ...binding.metadata } } : {}),
  }
}
