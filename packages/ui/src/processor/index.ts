/**
 * @weft/processor
 *
 * Pure-function event processor: SessionEvent → Message[]
 */

export type { StreamingState, SessionState, ProcessResult, Effect, Session, ChatEvent } from './types.ts';
export { processEvent } from './processor.ts';
export { mapCoreEventToProcessorEvent, mapTimelineEnvelopeToProcessorEvent } from './event-mapper.ts';
export { findStreamingMessage, findAssistantMessage, findToolMessage, updateMessageAt, appendMessage, generateMessageId } from './helpers.ts';

// Hooks
export { useEventProcessor } from './hooks/useEventProcessor.ts';

// Event Source interface
export type { EventSource, EventSourceCallback, EventSourceErrorCallback, EventSourceCloseCallback } from './event-source.ts';
export { WebSocketEventSource, SSEEventSource, InProcessEventSource } from './event-source.ts';
