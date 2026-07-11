/**
 * turn-helpers.ts
 *
 * Non-React utility functions and constants extracted from TurnCard.tsx.
 * These are pure functions with no JSX dependencies.
 */

import i18n from 'i18next'
import { EN_FALLBACK } from '../lib/en-fallback'
import { getTextDiffStats, getUnifiedDiffStats } from '../code-viewer'

// ============================================================================
// i18n Fallback
// ============================================================================

/** Fallback i18n.t for non-hook contexts (utility functions).
 *  React components should use useTranslation() which is reactive and
 *  initialized by i18n-init. This wrapper prevents "undefined" text when
 *  i18next is not initialized or has no resource for a key. */
export function t(key: string, options?: Record<string, unknown>): string {
  const result = i18n.t(key, options)
  // Fallback when i18next is uninitialized or has no resources for this key
  if (!result || result === key) {
    const fallback = EN_FALLBACK[key]
    if (!fallback) return key
    if (options) {
      return fallback.replace(/\{\{(\w+)\}\}/g, (_, k) => String(options[k] ?? ''))
    }
    return fallback
  }
  return result
}

// ============================================================================
// Markdown Stripping
// ============================================================================

/**
 * Simple markdown stripping for preview text.
 * Removes markdown syntax to show plain text preview.
 * Code block content is preserved as plain text.
 */
export function stripMarkdown(text: string): string {
  return text
    // Extract content from fenced code blocks (remove ``` and optional language)
    .replace(/```(?:\w+)?\n?([\s\S]*?)```/g, '$1')
    // Extract content from inline code
    .replace(/`([^`]+)`/g, '$1')
    // Remove headers
    .replace(/^#{1,6}\s+/gm, '')
    // Remove bold/italic
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    // Remove links
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    // Remove images
    .replace(/!\[[^\]]*\]\([^)]+\)/g, '')
    // Remove blockquotes
    .replace(/^>\s+/gm, '')
    // Remove horizontal rules
    .replace(/^---+$/gm, '')
    // Collapse whitespace
    .replace(/\s+/g, ' ')
    .trim()
}

// ============================================================================
// Diff Stats
// ============================================================================

/**
 * Compute diff stats for Edit/Write tool inputs.
 * Uses lightweight local line stats so the chat package does not pull in the
 * full diff rendering and Shiki language bundle.
 *
 * Supports both:
 * - Claude Code format: { file_path, old_string, new_string }
 * - Codex format: { changes: Array<{ path, kind, diff }> }
 *
 * @param toolName - 'Edit' or 'Write'
 * @param toolInput - The tool input containing old_string/new_string (Edit) or content (Write)
 * @returns { additions, deletions } or null if not applicable
 */
export function computeEditWriteDiffStats(
  toolName: string | undefined,
  toolInput: Record<string, unknown> | undefined
): { additions: number; deletions: number } | null {
  if (!toolInput) return null

  if (toolName === 'Edit') {
    // Check for Codex format: { changes: Array<{ path, kind, diff }> }
    if (toolInput.changes && Array.isArray(toolInput.changes)) {
      let totalAdditions = 0
      let totalDeletions = 0
      for (const change of toolInput.changes as Array<{ path?: string; diff?: string }>) {
        if (change.diff) {
          const stats = getUnifiedDiffStats(change.diff, change.path || 'file')
          if (stats) {
            totalAdditions += stats.additions
            totalDeletions += stats.deletions
          }
        }
      }
      if (totalAdditions === 0 && totalDeletions === 0) return null
      return { additions: totalAdditions, deletions: totalDeletions }
    }

    // Claude Code format: { file_path, old_string, new_string }
    const oldString = (toolInput.old_string as string) ?? ''
    const newString = (toolInput.new_string as string) ?? ''
    if (!oldString && !newString) return null

    const stats = getTextDiffStats(oldString, newString)
    if (stats.additions === 0 && stats.deletions === 0) return null
    return stats
  }

  if (toolName === 'Write') {
    const content = (toolInput.content as string) ?? ''
    if (!content) return null

    return getTextDiffStats('', content)
  }

  return null
}

// ============================================================================
// Size Configuration
// ============================================================================

/**
 * Global size configuration for TurnCard components.
 * Adjust these values to scale the entire component uniformly.
 */
/** Shared size configuration for activity UI - exported for reuse in inline execution */
export const SIZE_CONFIG = {
  /** Base font size class for all text */
  fontSize: 'text-[13px]',
  /** Icon size class (width and height) */
  iconSize: 'w-3 h-3',
  /** Spinner text size class */
  spinnerSize: 'text-[10px]',
  /** Small spinner for header */
  spinnerSizeSmall: 'text-[8px]',
  /** Activity row height in pixels (approx for calculation) */
  activityRowHeight: 24,
  /** Max visible activities before scrolling (show ~15 items) */
  maxVisibleActivities: 15,
  /** Number of items before which we apply staggered animation */
  staggeredAnimationLimit: 10,
} as const

// ============================================================================
// Buffering Constants & Content Detection Helpers
// ============================================================================

/**
 * Aggressive buffering configuration.
 * Waits until content is suspected to be meaningful "commentary" before showing.
 */
export const BUFFER_CONFIG = {
  MIN_WORDS_STANDARD: 1,       // Base threshold for showing content
  MIN_WORDS_CODE: 15,          // Code blocks show faster
  MIN_WORDS_LIST: 20,          // Lists show faster
  MIN_WORDS_QUESTION: 8,       // Questions from AI show faster
  MIN_WORDS_HEADER: 12,        // Headers indicate structure
  MIN_BUFFER_MS: 0,            // Show the first non-empty delta immediately
  MAX_BUFFER_MS: 800,          // Keep fallback short if markdown structure is ambiguous
  TIMEOUT_MIN_WORDS: 1,        // Show on timeout if at least this many words
  HIGH_WORD_COUNT: 60,         // Show regardless of structure at this count
  CONTENT_THROTTLE_MS: 60,     // Light throttle while preserving live streaming feel
} as const

export type BufferReason =
  | 'complete'
  | 'min_time'
  | 'timeout'
  | 'code_block'
  | 'list'
  | 'header'
  | 'question'
  | 'threshold_met'
  | 'high_word_count'
  | 'buffering'

/** Count words in text */
export function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(w => w.length > 0).length
}

/** Detect code blocks (fenced) */
export function hasCodeBlock(text: string): boolean {
  return /```/.test(text)
}

/** Detect markdown lists (bullet or numbered) */
export function hasList(text: string): boolean {
  return /^\s*[-*•]\s/m.test(text) || /^\s*\d+\.\s/m.test(text)
}

/** Detect markdown headers */
export function hasHeader(text: string): boolean {
  return /^#{1,4}\s/m.test(text)
}

/** Detect structural content (sentences, paragraphs, etc) */
export function hasStructure(text: string): boolean {
  // Sentence ending (period, exclamation, question mark, colon)
  if (/[.!?:]\s*$/.test(text.trimEnd())) return true
  // Paragraph breaks
  if (/\n\s*\n/.test(text)) return true
  // Headers anywhere
  if (/\n\s*#{1,4}\s/.test(text)) return true
  // Code blocks
  if (hasCodeBlock(text)) return true
  return false
}

/** Detect if text ends with a question (AI asking for clarification) */
export function isQuestion(text: string): boolean {
  return /\?\s*$/.test(text.trim())
}
