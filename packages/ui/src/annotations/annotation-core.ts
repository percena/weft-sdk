/**
 * annotation-core — stub for annotation overlay core utilities.
 *
 * Provides type definitions and utility functions for annotation rendering.
 * Full implementation will be ported from the upstream source project.
 */

import type { AnnotationV1 } from '@weft/core'
import type { AnchoredSelection } from './interaction-state-machine'

export const ANNOTATION_PREFIX_SUFFIX_WINDOW = 40
export const SELECTION_POINTER_MAX_AGE_MS = 5000

export interface AnnotationOverlayRect {
  id: string
  left: number
  top: number
  width: number
  height: number
  color: string
}

export type AnnotationOverlayChip = {
  id: string
  index: number
  left: number
  top: number
  sentFollowUp: boolean
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

export function hasExistingTextRangeAnnotation(
  annotations: AnnotationV1[],
  start: number,
  end: number,
): boolean {
  return annotations.some(a =>
    a.target.selectors.some(s =>
      s.type === 'text-position' && s.start === start && s.end === end
    )
  )
}

export function createSelectionPreviewAnnotation(
  messageId: string,
  sessionIdOrSelection: string | AnchoredSelection,
  startOrSessionId?: number | string,
  end?: number,
  exact?: string,
): AnnotationV1 {
  // Support both 5-arg (messageId, sessionId, start, end, exact) and
  // 3-arg (messageId, pendingSelection, sessionId) call patterns
  if (typeof sessionIdOrSelection === 'object') {
    const sel = sessionIdOrSelection as AnchoredSelection
    const sid = startOrSessionId as string ?? ''
    return {
      id: `preview-${Date.now()}`,
      schemaVersion: 1,
      createdAt: Date.now(),
      body: [{ type: 'highlight' }],
      target: {
        source: { sessionId: sid, messageId },
        selectors: [
          { type: 'text-quote', exact: sel.exact ?? '' },
          { type: 'text-position', start: sel.start, end: sel.end },
        ],
      },
    }
  }
  return {
    id: `preview-${Date.now()}`,
    schemaVersion: 1,
    createdAt: Date.now(),
    body: [{ type: 'highlight' }],
    target: {
      source: { sessionId: sessionIdOrSelection, messageId },
      selectors: [
        { type: 'text-quote', exact: exact ?? '' },
        { type: 'text-position', start: startOrSessionId as number, end: end ?? 0 },
      ],
    },
  }
}

export function createTextSelectionAnnotation(
  messageId: string,
  sessionId: string,
  start: number,
  end: number,
  exact: string,
  note: string,
): AnnotationV1 {
  return {
    id: `sel-${Date.now()}`,
    schemaVersion: 1,
    createdAt: Date.now(),
    body: [{ type: 'note', text: note }],
    target: {
      source: { sessionId, messageId },
      selectors: [
        { type: 'text-quote', exact },
        { type: 'text-position', start, end },
      ],
    },
  }
}

export interface TextSegment {
  start: number
  end: number
  node: Text
}

export function collectTextSegments(
  _content: string | HTMLElement,
  _annotations: AnnotationV1[],
): TextSegment[] {
  return []
}

/** Stub — full implementation will compute canonical text from DOM */
export function getCanonicalText(_content: string | HTMLElement): string {
  if (typeof _content === 'string') return _content
  return ''
}

/**
 * Stub — resolves character offset within a DOM node.
 * Full implementation will walk the DOM tree to compute text offset.
 */
export function resolveNodeOffset(
  _root: string | HTMLElement,
  _node?: Node,
  _offset?: number,
): number | null {
  return _offset ?? null
}

/** Stub — format annotation stats from diff content */
export function getUnifiedDiffStats(
  _diff: string,
  _path?: string,
): { added: number; removed: number } {
  return { added: 0, removed: 0 }
}

/** Stub — check whether a message can be annotated */
export function canAnnotateMessage(
  _opts: { hasAddAnnotationHandler: boolean; hasMessageId: boolean; isStreaming: boolean } | string,
): boolean {
  if (typeof _opts === 'string') return true
  return _opts.hasAddAnnotationHandler && _opts.hasMessageId
}