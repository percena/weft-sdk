/**
 * tool-display.ts
 *
 * Tool display formatting functions extracted from TurnCard.tsx.
 * No JSX — pure string/object formatting logic.
 */

import { normalizePath, pathStartsWith, stripPathPrefix } from '@weft/core/utils'
import type { ActivityItem, ResponseContent } from './turn-types'
import {
  countWords,
  hasCodeBlock,
  hasList,
  hasHeader,
  hasStructure,
  isQuestion,
  BUFFER_CONFIG,
  t,
  type BufferReason,
} from './turn-helpers'

// ============================================================================
// Streaming Content Decision
// ============================================================================

/**
 * Determine if buffered content should be shown.
 * This is the core buffering decision function.
 *
 * @param text - The accumulated response text
 * @param isStreaming - Whether the response is still streaming
 * @param streamStartTime - When streaming started (for timeout calculation)
 * @returns Decision with reason for debugging
 */
export function shouldShowStreamingContent(
  text: string,
  isStreaming: boolean,
  streamStartTime?: number
): { shouldShow: boolean; reason: BufferReason; wordCount: number } {
  const wordCount = countWords(text)

  // Always show complete content immediately
  if (!isStreaming) {
    return { shouldShow: true, reason: 'complete', wordCount }
  }

  if (text.trim().length > 0) {
    return { shouldShow: true, reason: 'threshold_met', wordCount }
  }

  const elapsed = streamStartTime ? Date.now() - streamStartTime : 0

  // Minimum buffer time - always wait at least 500ms
  if (elapsed < BUFFER_CONFIG.MIN_BUFFER_MS) {
    return { shouldShow: false, reason: 'min_time', wordCount }
  }

  // Maximum buffer time - force show after 2.5s if we have some content
  if (elapsed > BUFFER_CONFIG.MAX_BUFFER_MS && wordCount >= BUFFER_CONFIG.TIMEOUT_MIN_WORDS) {
    return { shouldShow: true, reason: 'timeout', wordCount }
  }

  // High-confidence patterns get expedited treatment

  // Code blocks - developers want to see code early
  if (hasCodeBlock(text) && wordCount >= BUFFER_CONFIG.MIN_WORDS_CODE) {
    return { shouldShow: true, reason: 'code_block', wordCount }
  }

  // Headers indicate structured content
  if (hasHeader(text) && wordCount >= BUFFER_CONFIG.MIN_WORDS_HEADER) {
    return { shouldShow: true, reason: 'header', wordCount }
  }

  // Lists indicate structured content
  if (hasList(text) && wordCount >= BUFFER_CONFIG.MIN_WORDS_LIST) {
    return { shouldShow: true, reason: 'list', wordCount }
  }

  // Questions from AI (clarification) - show quickly
  if (isQuestion(text) && wordCount >= BUFFER_CONFIG.MIN_WORDS_QUESTION) {
    return { shouldShow: true, reason: 'question', wordCount }
  }

  // Standard threshold - 40 words with some structure
  if (wordCount >= BUFFER_CONFIG.MIN_WORDS_STANDARD && hasStructure(text)) {
    return { shouldShow: true, reason: 'threshold_met', wordCount }
  }

  // High word count - show regardless of structure
  if (wordCount >= BUFFER_CONFIG.HIGH_WORD_COUNT) {
    return { shouldShow: true, reason: 'high_word_count', wordCount }
  }

  return { shouldShow: false, reason: 'buffering', wordCount }
}

/**
 * Check if a response is currently in buffering state
 * Used by TurnCard to show subtle indicator instead of big card
 */
export function isResponseBuffering(response: ResponseContent | undefined): boolean {
  if (!response) return false
  if (!response.isStreaming) return false
  const decision = shouldShowStreamingContent(response.text, response.isStreaming, response.streamStartTime)
  return !decision.shouldShow
}

// ============================================================================
// Tool Display Helpers
// ============================================================================

/** Get display name for a tool (strip MCP prefixes, apply friendly names) */
export function getToolDisplayName(name: string): string {
  const stripped = name.replace(/^mcp__[^_]+__/, '')

  // Friendly display names for specific tools
  const displayNames: Record<string, string> = {
    'TodoWrite': 'Todo List Updated',
    'set_session_labels': 'Set Session Labels',
    'set_session_status': 'Set Session Status',
    'get_session_info': 'Get Session Info',
    'list_sessions': 'List Sessions',
  }

  return displayNames[stripped] || stripped
}

/**
 * Strip session/workspace folder paths from file paths for cleaner display.
 * Only strips paths that match the current session folder path.
 * Example: /path/to/sessions/260121-foo/plans/file.md → plans/file.md
 */
export function stripSessionFolderPath(filePath: string, sessionFolderPath?: string): string {
  if (!sessionFolderPath) return filePath

  // Get workspace path (parent of sessions folder)
  // sessionFolderPath: /path/workspaces/{uuid}/sessions/{sessionId}
  const workspacePath = normalizePath(sessionFolderPath).replace(/\/sessions\/[^/]+$/, '')

  // Try session folder first (more specific)
  if (pathStartsWith(filePath, sessionFolderPath)) {
    return stripPathPrefix(filePath, sessionFolderPath)
  }

  // Then try workspace folder
  if (pathStartsWith(filePath, workspacePath)) {
    return stripPathPrefix(filePath, workspacePath)
  }

  return filePath
}

/** Format tool input as a concise summary - CSS truncate handles overflow */
export function formatToolInput(
  input?: Record<string, unknown>,
  toolName?: string,
  sessionFolderPath?: string
): string {
  if (!input || Object.keys(input).length === 0) return ''

  // For call_llm: model shown as badge, prompt duplicates intent
  if (toolName === 'mcp__session__call_llm') return ''

  const parts: string[] = []

  // For Edit/Write tools, only show file_path (skip old_string, new_string, replace_all, content)
  const isEditOrWrite = toolName === 'Edit' || toolName === 'Write'

  // Handle Codex format: { changes: Array<{ path, kind, diff }> }
  // Extract path from first change if present
  if (isEditOrWrite && input.changes && Array.isArray(input.changes)) {
    const firstChange = input.changes[0] as { path?: string } | undefined
    if (firstChange?.path) {
      const pathStr = stripSessionFolderPath(firstChange.path, sessionFolderPath)
      parts.push(pathStr)
    }
    return parts.join(' ')
  }

  for (const [key, value] of Object.entries(input)) {
    // Skip meta fields and description (shown separately)
    if (key === '_intent' || key === 'description' || value === undefined || value === null) continue

    // For Edit/Write tools, only include file_path
    if (isEditOrWrite && key !== 'file_path') continue

    let valStr = typeof value === 'string'
      ? value.replace(/\s+/g, ' ').trim()
      : JSON.stringify(value)

    // Strip session/workspace paths from file_path for Edit/Write tools
    if (isEditOrWrite && key === 'file_path' && typeof value === 'string') {
      valStr = stripSessionFolderPath(valStr, sessionFolderPath)
    }

    parts.push(valStr)
    if (parts.length >= 2) break // Max 2 values
  }
  return parts.join(' ')
}

/**
 * Extract the action portion from an LLM-provided displayName by stripping
 * a matching icon/tool prefix.
 *
 * Examples:
 *   extractActionFromDisplayName("Git", "Git Status")  → "Status"
 *   extractActionFromDisplayName("npm", "Install Deps") → "Install Deps"
 *   extractActionFromDisplayName("Git", "Check Branch")  → "Check Branch"
 */
function extractActionFromDisplayName(iconName: string, llmName: string): string {
  // If LLM name starts with the icon name, strip the prefix to get the action
  // "Git Status" with icon "Git" → "Status"
  if (llmName.toLowerCase().startsWith(`${iconName.toLowerCase()} `)) {
    return llmName.slice(iconName.length + 1).trim()
  }
  // Otherwise use the full LLM name as the action
  // "Install Dependencies" with icon "npm" → "Install Dependencies"
  return llmName
}

/**
 * Format tool display using embedded toolDisplayMeta.
 * toolDisplayMeta is set at storage time in the main process and includes:
 * - displayName: Human-readable name
 * - iconDataUrl: Base64-encoded icon (for skills/sources)
 * - description: Brief description
 * - category: 'skill' | 'source' | 'native' | 'mcp'
 */
export function formatToolDisplay(
  activity: ActivityItem
): { name: string; icon?: string; description?: string } {
  const { toolName, displayName, toolInput, toolDisplayMeta } = activity

  // Primary: Use embedded toolDisplayMeta (works in both Electron and viewer)
  if (toolDisplayMeta) {
    // For MCP tools, append the tool slug to the source name
    if (toolName?.startsWith('mcp__') && toolDisplayMeta.category === 'source') {
      const parts = toolName.match(/^mcp__([^_]+)__(.+)$/)
      if (parts) {
        const toolSlug = parts[2]
        return {
          name: `${toolDisplayMeta.displayName}: ${toolSlug}`,
          icon: toolDisplayMeta.iconDataUrl,
          description: toolDisplayMeta.description,
        }
      }
    }

    // For Bash commands with LLM-provided displayName: merge icon name + action
    // e.g., icon "Git" + LLM "Git Status" → "Git: Status"
    // e.g., icon "npm" + LLM "Install Dependencies" → "npm: Install Dependencies"
    // Special case: for generic "Terminal", show only the action
    // e.g., icon "Terminal" + LLM "Install Dependencies" → "Install Dependencies"
    if (toolName === 'Bash' && displayName) {
      const iconName = toolDisplayMeta.displayName
      const action = extractActionFromDisplayName(iconName, displayName)
      return {
        name: iconName.toLowerCase() === 'terminal' ? action : `${iconName}: ${action}`,
        icon: toolDisplayMeta.iconDataUrl,
        description: toolDisplayMeta.description,
      }
    }

    // For native tools with LLM-provided displayName: use the LLM's name
    // This gives semantic names like "Read Config" instead of generic "Read"
    if (displayName && toolDisplayMeta.category === 'native') {
      return {
        name: displayName,
        icon: toolDisplayMeta.iconDataUrl,
        description: toolDisplayMeta.description,
      }
    }

    return {
      name: toolDisplayMeta.displayName,
      icon: toolDisplayMeta.iconDataUrl,
      description: toolDisplayMeta.description,
    }
  }

  // Fallback for Skill tool without toolDisplayMeta (legacy sessions)
  if (toolName === 'Skill' && toolInput?.skill) {
    const skillId = String(toolInput.skill)
    // Extract slug from qualified name (workspaceId:slug) for display
    const colonIdx = skillId.indexOf(':')
    const slug = colonIdx > 0 ? skillId.slice(colonIdx + 1) : skillId
    return { name: slug }
  }

  // Final fallback: Use LLM-generated displayName or tool name
  const name = displayName || (toolName ? getToolDisplayName(toolName) : t('turnCard.processing'))
  return { name }
}

/** Get the primary preview text for collapsed state */
export function getPreviewText(
  activities: ActivityItem[],
  intent?: string,
  isStreaming?: boolean,
  hasResponse?: boolean,
  isComplete?: boolean
): string {
  // If we have an explicit intent, use it
  if (intent) return intent

  // Find the most relevant activity intent
  const activityWithIntent = activities.find(a => a.intent)
  if (activityWithIntent?.intent) return activityWithIntent.intent

  // Check if we're in responding state
  if (isStreaming && hasResponse) return t('turnCard.responding')

  // Find running Task tools and show their description
  const runningTask = activities.find(a => a.toolName === 'Task' && a.status === 'running')
  if (runningTask?.toolInput?.description) {
    return runningTask.toolInput.description as string
  }

  // While still streaming, show the latest intermediate message content
  // This gives visibility into what the LLM is "thinking"
  if (isStreaming && !isComplete) {
    const latestIntermediate = [...activities]
      .reverse()
      .find(a => a.type === 'intermediate' && a.content)
    if (latestIntermediate?.content) {
      return latestIntermediate.content
    }
  }

  // Get running and completed tools (not intermediate messages)
  const runningTools = activities.filter(a => a.status === 'running' && a.toolName)
  const errorCount = activities.filter(a => a.status === 'error').length

  // Show running tool names
  if (runningTools.length > 0) {
    const toolNames = runningTools
      .map(a => getToolDisplayName(a.toolName!))
      .slice(0, 3) // Max 3 names
    return `${toolNames.join(', ')}...`
  }

  // When complete, show first Task's description if available
  const firstTask = activities.find(a => a.toolName === 'Task')
  if (firstTask?.toolInput?.description) {
    const errorSuffix = errorCount > 0
      ? t('turnCard.errorCount', { count: errorCount })
      : ''
    return `${firstTask.toolInput.description as string}${errorSuffix}`
  }

  // When complete, show summary (badge already shows count)
  if (isComplete || (!isStreaming && activities.length > 0)) {
    const errorSuffix = errorCount > 0
      ? t('turnCard.errorCount', { count: errorCount })
      : ''
    return `${t('turnCard.stepsCompleted')}${errorSuffix}`
  }

  return t('turnCard.starting')
}
