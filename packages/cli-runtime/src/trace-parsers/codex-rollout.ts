/**
 * CodexRolloutAdapter — parse Codex rollout JSONL into AgentEvent[].
 *
 * References: Paseo codex-rollout-timeline.ts for boundary coverage,
 * Craft AgentEvent for output type alignment.
 *
 * Key responsibilities:
 * - response_item / event_msg mirror deduplication
 * - function_call → tool_start, function_call_output → tool_result (by call_id)
 * - exec_command_begin → tool_start { Bash }, exec_command_end → tool_result
 * - apply_patch → tool_start { Edit }, patch_apply_end → tool_result
 * - reasoning → text_complete { isIntermediate: true }
 * - synthetic environment/user messages filtering
 * - shell envelope output extraction
 */

import type { AgentEvent } from '@weft/core'
import { TraceEventAdapter } from './base-event-adapter.ts'

// ============================================================================
// Codex rollout JSONL event types (input format)
// ============================================================================

/** A single JSONL line from Codex rollout */
export type RolloutEvent = {
  type: string;
  [key: string]: unknown;
};

// ============================================================================
// CodexRolloutAdapter extends TraceEventAdapter
// ============================================================================

export class CodexRolloutAdapter extends TraceEventAdapter {
  // Per-turn state for deduplication
  private emittedEventMsgIds: Set<string> = new Set();
  private pendingAssistantText: string | null = null;
  private pendingAssistantTurnId: string | null = null;

  protected onTurnStart(): void {
    this.emittedEventMsgIds.clear();
    this.pendingAssistantText = null;
    this.pendingAssistantTurnId = null;
  }

  /**
   * Parse a complete rollout JSONL string into AgentEvent[].
   * Each line is a JSON object representing a Codex event.
   */
  parseRollout(rolloutJsonl: string): AgentEvent[] {
    const events: AgentEvent[] = [];
    const lines = rolloutJsonl.split('\n').filter((l) => l.trim());

    this.startTurn();

    for (const line of lines) {
      try {
        const obj = JSON.parse(line) as RolloutEvent;
        const parsed = this.adaptRolloutEvent(obj);
        events.push(...parsed);
      } catch {
        // Skip malformed JSON lines
      }
    }

    // Flush any pending text at end of rollout
    if (this.pendingAssistantText) {
      events.push({
        type: 'text_complete',
        text: this.pendingAssistantText,
        isIntermediate: false,
        turnId: this.pendingAssistantTurnId || this.currentTurnId || undefined,
      });
      this.pendingAssistantText = null;
    }

    // Emit complete if not already done
    const hasComplete = events.some((e) => e.type === 'complete');
    if (!hasComplete && events.length > 0) {
      events.push({ type: 'complete' });
    }

    return events;
  }

  /**
   * Adapt a single Codex rollout event to AgentEvent[].
   */
  private adaptRolloutEvent(event: RolloutEvent): AgentEvent[] {
    const events: AgentEvent[] = [];

    switch (event.type) {
      // ====================================================================
      // Text & reasoning events
      // ====================================================================

      case 'response_item': {
        const item = event as ResponseItemEvent;
        // Deduplicate: response_item mirrors event_msg
        if (item.id && this.emittedEventMsgIds.has(item.id)) {
          break; // Already emitted via event_msg, skip
        }

        if (item.role === 'assistant') {
          const text = extractTextFromContent(item.content);
          if (text) {
            // Check if this is reasoning or intermediate text
            const isReasoning = item.metadata?.reasoning === true;
            const isIntermediate = isReasoning || hasToolUseInContent(item.content);

            if (isIntermediate) {
              // Intermediate reasoning/commentary before tool calls
              events.push({
                type: 'text_complete',
                text,
                isIntermediate: true,
                turnId: this.currentTurnId || undefined,
              });
            } else {
              // Final response text — buffer until we're sure no more events
              this.pendingAssistantText = text;
              this.pendingAssistantTurnId = this.currentTurnId;
            }
          }

          // Extract tool_use blocks from content
          const toolUses = extractToolUsesFromContent(item.content);
          for (const tu of toolUses) {
            this.toolIndex.append(tu.id, tu.name, tu.input as Record<string, unknown>);
            events.push(this.createToolStart(tu.id, tu.name, tu.input as Record<string, unknown>, undefined, undefined));
          }
        }

        // Filter synthetic environment/user messages
        if (item.role === 'user' && isSyntheticMessage(item)) {
          break;
        }

        break;
      }

      case 'event_msg': {
        const msg = event as EventMsgEvent;
        // Deduplicate: mark this ID so response_item skips it
        if (msg.id) {
          this.emittedEventMsgIds.add(msg.id);
        }

        // Only emit if this is an assistant message not yet covered by response_item
        if (msg.role === 'assistant' && msg.message) {
          events.push({
            type: 'text_complete',
            text: msg.message,
            isIntermediate: false,
            turnId: this.currentTurnId || undefined,
          });
        }
        break;
      }

      case 'agent_message_delta': {
        const delta = event as MessageDeltaEvent;
        if (delta.delta) {
          events.push({
            type: 'text_delta',
            text: delta.delta,
            turnId: this.currentTurnId || undefined,
          });
        }
        break;
      }

      case 'agent_reasoning': {
        const reasoning = event as ReasoningEvent;
        if (reasoning.text) {
          events.push({
            type: 'text_complete',
            text: reasoning.text,
            isIntermediate: true,
            turnId: this.currentTurnId || undefined,
          });
        }
        break;
      }

      case 'agent_reasoning_delta': {
        const delta = event as ReasoningDeltaEvent;
        if (delta.delta) {
          events.push({
            type: 'text_delta',
            text: delta.delta,
            turnId: this.currentTurnId || undefined,
          });
        }
        break;
      }

      // ====================================================================
      // Command execution events
      // ====================================================================

      case 'exec_command_begin': {
        const cmd = event as ExecCommandBeginEvent;
        const command = Array.isArray(cmd.command) ? cmd.command.join(' ') : String(cmd.command ?? '');
        const cwd = cmd.cwd ?? '';

        // Classify bash reads
        const readInfo = this.classifyReadCommand(cmd.call_id, command);
        if (readInfo) {
          events.push(this.createReadToolStart(cmd.call_id, readInfo));
        } else {
          events.push(
            this.createToolStart(cmd.call_id, 'Bash', {
              command,
              cwd,
            }, undefined, 'Execute Command'),
          );
        }
        this.toolIndex.append(cmd.call_id, 'Bash', { command, cwd });
        break;
      }

      case 'exec_command_output_delta': {
        const delta = event as ExecCommandOutputDeltaEvent;
        // Accumulate output deltas for later tool_result
        const decoded = decodeBase64Chunk(delta.chunk);
        if (decoded) {
          this.accumulateOutput(delta.call_id, decoded);
        }
        break;
      }

      case 'exec_command_end': {
        const cmdEnd = event as ExecCommandEndEvent;
        const accumulated = this.consumeOutput(cmdEnd.call_id);
        const output = accumulated ?? cmdEnd.stdout ?? cmdEnd.formatted_output ?? '';

        // Check for shell envelope header stripping
        const cleanOutput = stripShellEnvelope(output);

        const isError = cmdEnd.exit_code !== 0;
        const readInfo = this.consumeReadCommand(cmdEnd.call_id);

        events.push(
          this.createToolResult(
            cmdEnd.call_id,
            readInfo ? 'Read' : 'Bash',
            cleanOutput,
            isError,
          ),
        );

        // After tool completion, assistant may generate new text
        this.pendingAssistantText = null;
        break;
      }

      // ====================================================================
      // Patch / file modification events
      // ====================================================================

      case 'apply_patch_approval_request':
      case 'patch_apply_begin': {
        const patch = event as PatchApplyBeginEvent;
        const callId = patch.call_id ?? `patch-${this.turnIndex}`;
        const changes = patch.changes ?? {};

        // Build a summary of file changes for tool input
        const filePaths = Object.keys(changes);
        const input: Record<string, unknown> = {
          changes: changes,
          file_paths: filePaths,
        };

        if (filePaths.length === 1) {
          input.file_path = filePaths[0];
          const change = changes[filePaths[0]];
          if (change && typeof change === 'object') {
            if ('unified_diff' in change) input.unified_diff = (change as Record<string, unknown>).unified_diff as string;
            if ('content' in change) input.content = (change as Record<string, unknown>).content as string;
          }
        }

        events.push(
          this.createToolStart(callId, 'Edit', input, undefined, 'Apply Patch'),
        );
        this.toolIndex.append(callId, 'Edit', input);
        break;
      }

      case 'patch_apply_end': {
        const end = event as PatchApplyEndEvent;
        const callId = end.call_id ?? `patch-${this.turnIndex}`;
        const result = end.stdout ?? (end.success ? 'Patch applied successfully' : end.error ?? 'Patch failed');

        events.push(
          this.createToolResult(callId, 'Edit', result, !end.success),
        );
        break;
      }

      // ====================================================================
      // MCP tool events
      // ====================================================================

      case 'mcp_tool_call_begin': {
        const mcp = event as McpToolCallBeginEvent;
        const callId = mcp.call_id ?? `mcp-${this.turnIndex}`;
        const invocation = mcp.invocation ?? {};
        const toolName = this.buildMcpToolName(invocation.server ?? 'unknown', invocation.tool ?? 'unknown');
        const input = (invocation.arguments ?? {}) as Record<string, unknown>;

        events.push(
          this.createToolStart(callId, toolName, input, undefined, invocation.tool ?? toolName),
        );
        this.toolIndex.append(callId, toolName, input);
        break;
      }

      case 'mcp_tool_call_end': {
        const mcpEnd = event as McpToolCallEndEvent;
        const callId = mcpEnd.call_id ?? `mcp-${this.turnIndex}`;
        const result = mcpEnd.result ?? (mcpEnd.error ?? 'MCP call completed');
        const isError = Boolean(mcpEnd.error);

        events.push(
          this.createToolResult(callId, 'MCP', typeof result === 'string' ? result : JSON.stringify(result), isError),
        );
        break;
      }

      // ====================================================================
      // Web search events
      // ====================================================================

      case 'web_search_begin': {
        const ws = event as WebSearchBeginEvent;
        const callId = ws.call_id ?? `search-${this.turnIndex}`;
        events.push(
          this.createToolStart(callId, 'WebSearch', {}, undefined, 'Web Search'),
        );
        this.toolIndex.append(callId, 'WebSearch', {});
        break;
      }

      case 'web_search_end': {
        const wsEnd = event as WebSearchEndEvent;
        const callId = wsEnd.call_id ?? `search-${this.turnIndex}`;
        const result = wsEnd.query ?? 'Search completed';
        events.push(
          this.createToolResult(callId, 'WebSearch', result, false),
        );
        break;
      }

      // ====================================================================
      // Turn diff (file change summary)
      // ====================================================================

      case 'turn_diff': {
        const diff = event as TurnDiffEvent;
        if (diff.unified_diff) {
          // Parse unified diff to extract file paths
          const filePaths = extractFilePathsFromDiff(diff.unified_diff);
          for (const fp of filePaths) {
            events.push(
              this.createToolStart(
                `diff-${fp}-${this.turnIndex}`,
                'Edit',
                { file_path: fp, unified_diff: diff.unified_diff },
                undefined,
                `Changed: ${fp}`,
              ),
            );
          }
        }
        break;
      }

      case 'write_stdin': {
        // Terminal activity marker for long-running session polling
        const stdin = event as WriteStdinEvent;
        events.push({
          type: 'status',
          message: stdin.content ? `Terminal input: ${stdin.content.slice(0, 80)}${stdin.content.length > 80 ? '...' : ''}` : 'Terminal interaction',
        });
        break;
      }

      case 'function_call_output': {
        // Independent function_call_output event (not nested in response_item)
        const fco = event as FunctionCallOutputEvent;
        const toolName = this.toolIndex.find(fco.call_id)?.name ?? 'tool';
        events.push(
          this.createToolResult(fco.call_id, toolName, fco.output ?? '', fco.is_error ?? false),
        );
        this.toolIndex.markMatched(fco.call_id);
        break;
      }

      // ====================================================================
      // Lifecycle events
      // ====================================================================

      case 'error': {
        // Top-level `ThreadEvent::Error` (`{ type: 'error', message }` /
        // `{ type: 'error', error: { message } }`). Surface the message as a
        // status event so a persisted rollout's errors are not silently dropped.
        const err = event as ErrorEvent;
        const message = err.message ?? (typeof err.error === 'string' ? err.error : err.error?.message) ?? 'Codex error';
        events.push({
          type: 'status',
          message,
        });
        break;
      }

      case 'task_complete': {
        const _tc = event as TaskCompleteEvent;
        // Flush pending text as final response
        if (this.pendingAssistantText) {
          events.push({
            type: 'text_complete',
            text: this.pendingAssistantText,
            isIntermediate: false,
            turnId: this.pendingAssistantTurnId || this.currentTurnId || undefined,
          });
          this.pendingAssistantText = null;
        }
        events.push({ type: 'complete' });
        break;
      }

      // ====================================================================
      // Ignored events (no UI value or handled elsewhere)
      // ====================================================================

      case 'session_configured':
      case 'task_started':
      case 'token_count':
      case 'user_message': // Filter synthetic, handle real user messages separately
      case 'agent_message': // Full message, redundant with delta/complete
      case 'conversation_path':
      case 'background_event':
      case 'turn_aborted':
        // `todo_list` is not a top-level rollout event — it is a
        // `ThreadItemDetails` variant nested inside `item.*` events (which this
        // parser does not switch on; it consumes the older rollout vocabulary
        // of response_item/exec_command_begin/etc.). Intentionally ignored here
        // rather than guessed at; the structured plan is surfaced via the
        // `plan` item on the app-server path.
        break;

      default:
        // Unknown event types — skip silently
        break;
    }

    return events;
  }
}

// ============================================================================
// Codex rollout event type definitions (input format)
// ============================================================================

type ResponseItemEvent = {
  type: 'response_item';
  id?: string;
  role?: string;
  content?: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>;
  metadata?: { reasoning?: boolean };
  [key: string]: unknown;
};

type EventMsgEvent = {
  type: 'event_msg';
  id?: string;
  role?: string;
  message?: string;
  [key: string]: unknown;
};

type MessageDeltaEvent = {
  type: 'agent_message_delta';
  delta?: string;
  [key: string]: unknown;
};

type ReasoningEvent = {
  type: 'agent_reasoning';
  text?: string;
  [key: string]: unknown;
};

type ReasoningDeltaEvent = {
  type: 'agent_reasoning_delta';
  delta?: string;
  [key: string]: unknown;
};

type ExecCommandBeginEvent = {
  type: 'exec_command_begin';
  call_id: string;
  command?: string[] | string;
  cwd?: string;
  [key: string]: unknown;
};

type ExecCommandOutputDeltaEvent = {
  type: 'exec_command_output_delta';
  call_id: string;
  stream?: 'stdout' | 'stderr';
  chunk?: string;
  [key: string]: unknown;
};

type ExecCommandEndEvent = {
  type: 'exec_command_end';
  call_id: string;
  stdout?: string;
  stderr?: string;
  aggregated_output?: string;
  formatted_output?: string;
  exit_code?: number;
  [key: string]: unknown;
};

type PatchApplyBeginEvent = {
  type: 'apply_patch_approval_request' | 'patch_apply_begin';
  call_id?: string;
  changes?: Record<string, unknown>;
  [key: string]: unknown;
};

type PatchApplyEndEvent = {
  type: 'patch_apply_end';
  call_id?: string;
  success?: boolean;
  error?: string;
  stdout?: string;
  [key: string]: unknown;
};

type McpToolCallBeginEvent = {
  type: 'mcp_tool_call_begin';
  call_id?: string;
  invocation?: { server?: string; tool?: string; arguments?: Record<string, unknown> };
  [key: string]: unknown;
};

type McpToolCallEndEvent = {
  type: 'mcp_tool_call_end';
  call_id?: string;
  result?: unknown;
  error?: string;
  [key: string]: unknown;
};

type WebSearchBeginEvent = {
  type: 'web_search_begin';
  call_id?: string;
  [key: string]: unknown;
};

type WebSearchEndEvent = {
  type: 'web_search_end';
  call_id?: string;
  query?: string;
  results?: unknown[];
  [key: string]: unknown;
};

type TurnDiffEvent = {
  type: 'turn_diff';
  unified_diff?: string;
  [key: string]: unknown;
};

type TaskCompleteEvent = {
  type: 'task_complete';
  last_agent_message?: string;
  [key: string]: unknown;
};

type WriteStdinEvent = {
  type: 'write_stdin';
  call_id?: string;
  content?: string;
  [key: string]: unknown;
};

type FunctionCallOutputEvent = {
  type: 'function_call_output';
  call_id: string;
  output?: string;
  is_error?: boolean;
  [key: string]: unknown;
};

type ErrorEvent = {
  type: 'error';
  message?: string;
  error?: string | { message?: string; [key: string]: unknown };
  [key: string]: unknown;
};

// ============================================================================
// Helper functions
// ============================================================================

function extractTextFromContent(content: Array<{ type: string; text?: string }> | undefined): string | null {
  if (!content) return null;
  let text = '';
  for (const block of content) {
    if (block.type === 'text' && block.text) {
      text += block.text;
    }
  }
  return text || null;
}

function hasToolUseInContent(content: Array<{ type: string }> | undefined): boolean {
  if (!content) return false;
  return content.some((block) => block.type === 'tool_use');
}

function extractToolUsesFromContent(
  content: Array<{ type: string; id?: string; name?: string; input?: unknown }> | undefined,
): Array<{ id: string; name: string; input: unknown }> {
  if (!content) return [];
  const result: Array<{ id: string; name: string; input: unknown }> = [];
  for (const block of content) {
    if (block.type === 'tool_use' && block.id && block.name) {
      result.push({ id: block.id, name: block.name, input: block.input ?? {} });
    }
  }
  return result;
}

function isSyntheticMessage(item: ResponseItemEvent): boolean {
  // Filter synthetic environment/context messages
  const content = item.content;
  if (!content) return false;
  for (const block of content) {
    if (block.type === 'text' && block.text) {
      // Synthetic messages often contain environment context or tool results
      // that shouldn appear in the user transcript
      if (
        block.text.startsWith('<environment>') ||
        block.text.startsWith('<system-reminder>') ||
        block.text.includes('is not available') && block.text.includes('Working directory')
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Decode a base64 chunk from Codex exec_command_output_delta.
 * Codex sends output as base64-encoded byte arrays.
 */
function decodeBase64Chunk(chunk: string | undefined): string | null {
  if (!chunk) return null;
  try {
    return atob(chunk);
  } catch {
    // Not valid base64, return as-is (some formats send plain text)
    return chunk;
  }
}

/**
 * Strip Codex shell envelope header from output.
 * Envelope format: "[stdout/stderr] content" or ANSI escape codes.
 */
function stripShellEnvelope(output: string): string {
  // Remove common envelope patterns
  return output
    .replace(/^\[(stdout|stderr)\]\s*/i, '')
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '') // Strip ANSI escapes
    .trim();
}

/**
 * Extract file paths from a unified diff string.
 */
function extractFilePathsFromDiff(diff: string): string[] {
  const paths: string[] = [];
  for (const line of diff.split('\n')) {
    const match = line.match(/^diff --git\s+a\/(.+)\s+b\/(.+)/);
    if (match) {
      paths.push(match[2]);
    }
    // Also match +++ lines
    const plusMatch = line.match(/^\+\+\+\s+b\/(.+)/);
    if (plusMatch && !paths.includes(plusMatch[1])) {
      paths.push(plusMatch[1]);
    }
  }
  return paths;
}
/**
 * Parse a complete Codex rollout JSONL trace into AgentEvent[].
 * Convenience wrapper for one-shot replay of persisted runs.
 */
export function parseCodexRolloutTrace(rolloutJsonl: string): AgentEvent[] {
  return new CodexRolloutAdapter().parseRollout(rolloutJsonl)
}
