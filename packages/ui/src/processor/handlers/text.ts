/**
 * Text Event Handlers
 *
 * Handles text_delta and text_complete events.
 * Pure functions that return new state - no side effects.
 */

import type { SessionState, StreamingState, TextDeltaEvent, TextCompleteEvent } from '../types'
import type { Message } from '@weft/core'
import {
  findStreamingMessage,
  findAssistantMessage,
  updateMessageAt,
  appendMessage,
  generateMessageId
} from '../helpers'

/**
 * Handle text_delta - accumulate streaming content
 *
 * Creates a new streaming message if none exists, otherwise updates existing.
 * Uses turnId for lookup, never position.
 *
 * When a non-intermediate delta (response text) arrives while an intermediate
 * message (reasoning) is still streaming, the reasoning message is closed and
 * a fresh streaming message is created so the two never share content.
 */
export function handleTextDelta(
  state: SessionState,
  event: TextDeltaEvent
): SessionState {
  const { session, streaming } = state

  // Accumulate in streaming state
  const newStreaming: StreamingState = streaming
    ? {
        ...streaming,
        content: streaming.content + event.delta,
        turnId: event.turnId ?? streaming.turnId
      }
    : {
        content: event.delta,
        turnId: event.turnId
      }

  // Find existing streaming message by turnId
  const streamingIndex = findStreamingMessage(session.messages, event.turnId)

  if (streamingIndex !== -1) {
    const currentMsg = session.messages[streamingIndex]

    // Reasoning deltas and response deltas must live in separate messages.
    // When the first response delta arrives while a reasoning message is
    // still streaming, close the reasoning message and start a fresh one.
    if (currentMsg.isIntermediate && !event.isIntermediate) {
      const closedSession = updateMessageAt(session, streamingIndex, {
        isStreaming: false,
      })
      const newMessage: Message = {
        id: generateMessageId(),
        role: 'assistant',
        content: event.delta,
        timestamp: event.timestamp ?? Date.now(),
        isStreaming: true,
        isPending: true,
        turnId: event.turnId,
      }
      return {
        session: appendMessage(closedSession, newMessage, false),
        streaming: { content: event.delta, turnId: event.turnId },
      }
    }

    // Same intermediate-ness — append normally
    const updatedSession = updateMessageAt(session, streamingIndex, {
      content: currentMsg.content + event.delta,
    })
    return { session: updatedSession, streaming: newStreaming }
  }

  // No streaming message found - create new one
  // Don't update lastMessageAt for streaming messages (they're intermediate)
  const newMessage: Message = {
    id: generateMessageId(),
    role: 'assistant',
    content: event.delta,
    timestamp: event.timestamp ?? Date.now(),
    isStreaming: true,
    isPending: true,
    turnId: event.turnId,
    ...(event.isIntermediate ? { isIntermediate: true } : {}),
  }

  return {
    session: appendMessage(session, newMessage, false),
    streaming: newStreaming,
  }
}

/**
 * Handle text_complete - finalize the streaming message
 *
 * Sets isStreaming: false, isPending: false.
 * If message not found, CREATES it (fixes race condition bug).
 * Uses complete text from SDK (event.text), not accumulated content.
 */
export function handleTextComplete(
  state: SessionState,
  event: TextCompleteEvent
): SessionState {
  const { session, streaming } = state

  // Find message by turnId (try streaming first, then any assistant)
  let msgIndex = findStreamingMessage(session.messages, event.turnId)
  // An intermediate completion (reasoning) must not finalize a non-intermediate
  // streaming message — skip so findAssistantMessage locates the right target.
  if (msgIndex !== -1 && event.isIntermediate && !session.messages[msgIndex].isIntermediate) {
    msgIndex = -1
  }
  if (msgIndex === -1) {
    msgIndex = findAssistantMessage(session.messages, event.turnId)
  }

  if (msgIndex !== -1) {
    const existingMsg = session.messages[msgIndex]

    // Never overwrite a finalized intermediate message — each thinking block
    // should be distinct, and the response that follows must be a new message.
    // A message still pending (closed early in handleTextDelta's reasoning→
    // response transition) should be updated by its authoritative completion.
    if (!existingMsg.isStreaming && existingMsg.isIntermediate && !existingMsg.isPending) {
      msgIndex = -1
    }
  }

  if (msgIndex !== -1) {
    // Update existing message with final content
    // Only update lastMessageAt for final (non-intermediate) messages
    const shouldUpdateTimestamp = !event.isIntermediate
    const existingMsg = session.messages[msgIndex]
    // Fallback chain: SDK event text → accumulated streaming content → existing message content.
    // Guards against SDK quirks or race conditions where event.text arrives empty.
    const resolvedContent = event.text || streaming?.content || existingMsg?.content || ''
    const isCompletingAccumulatedText = Boolean(event.text) &&
      (event.text === existingMsg.content || event.text === streaming?.content)
    // Intermediate (thinking/reasoning) messages must keep their original
    // timestamp so they sort before the response in groupMessagesByTurn.
    // Advancing their timestamp to the completion time would place them after
    // the response and create a ghost assistant turn.
    const completedTimestamp = event.isIntermediate
      ? existingMsg.timestamp
      : isCompletingAccumulatedText
        ? existingMsg.timestamp
        : Math.max(event.timestamp ?? Date.now(), existingMsg.timestamp + 1)

    const updatedSession = updateMessageAt(session, msgIndex, {
      // Replace temporary renderer-generated ID with authoritative main-process ID
      // so branchFromMessageId always resolves against persisted session.jsonl.
      ...(event.messageId ? { id: event.messageId } : {}),
      content: resolvedContent,
      isStreaming: false,
      isPending: false,
      isIntermediate: event.isIntermediate,
      turnId: event.turnId,
      parentToolUseId: event.parentToolUseId,
      // Preserve the first delta timestamp so commentary that appeared before
      // a later tool call stays before that tool in the rendered transcript.
      // Empty completion events finalize a whole-turn stream, so they should
      // keep the completion timestamp instead of moving the full response up.
      timestamp: completedTimestamp,
    }, shouldUpdateTimestamp)
    return { session: updatedSession, streaming: null }
  }

  // Message not found - CREATE IT
  // This handles the race condition where text_complete arrives
  // before text_delta's setSessions has been processed
  const newMessage: Message = {
    id: event.messageId ?? generateMessageId(),
    role: 'assistant',
    content: event.text || streaming?.content || '',
    timestamp: event.timestamp ?? Date.now(),
    isStreaming: false,
    isPending: false,
    isIntermediate: event.isIntermediate,
    turnId: event.turnId,
    parentToolUseId: event.parentToolUseId,
  }

  // Only update lastMessageAt for final (non-intermediate) messages
  const shouldUpdateTimestamp = !event.isIntermediate

  return {
    session: appendMessage(session, newMessage, shouldUpdateTimestamp),
    streaming: null,
  }
}
