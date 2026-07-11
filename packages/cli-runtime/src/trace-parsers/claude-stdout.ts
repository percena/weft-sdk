/**
 * ClaudeStdoutParser — parse claude -p stdout into AgentEvent[].
 *
 * claude -p --no-session-persistence outputs plain text to stdout.
 * This parser extracts structured events from that text:
 * - Tool use markers (claude outputs tool calls in specific formats)
 * - Final response text
 * - Error messages from stderr
 * - Status indicators
 */

import type { AgentEvent } from '@weft/core'
import { TraceEventAdapter } from './base-event-adapter.ts'
import { generateTraceToolUseId } from './support.ts'

export class ClaudeStdoutAdapter extends TraceEventAdapter {
  private hasFinalResponse: boolean = false;

  protected onTurnStart(): void {
    this.hasFinalResponse = false;
  }

  /**
   * Parse claude -p stdout + stderr into AgentEvent[].
   *
   * Since claude -p output is mostly unstructured plain text,
   * we do a best-effort extraction of tool-related patterns
   * and map everything else to text_complete / status / error events.
   */
  parseOutput(stdout: string, stderr: string): AgentEvent[] {
    const events: AgentEvent[] = [];
    this.startTurn();

    // Process stderr first (errors)
    if (stderr.trim()) {
      const errorLines = stderr.split('\n').filter((l) => l.trim());
      for (const line of errorLines) {
        // Classify error severity
        if (
          line.includes('rate_limited') ||
          line.includes('Rate limit') ||
          line.includes('429')
        ) {
          events.push({ type: 'error', message: 'Rate limited — please wait and retry' });
        } else if (
          line.includes('invalid_api_key') ||
          line.includes('Authentication') ||
          line.includes('401') ||
          line.includes('403')
        ) {
          events.push({ type: 'error', message: 'Authentication error — check your API key' });
        } else if (
          line.includes('context_length_exceeded') ||
          line.includes('too long')
        ) {
          events.push({ type: 'error', message: 'Context limit exceeded' });
        } else {
          // Less critical stderr lines — show as status
          events.push({ type: 'status', message: line.trim() });
        }
      }
    }

    // Process stdout — extract tool patterns and response text
    const stdoutLines = stdout.split('\n');
    let responseText = '';
    let currentTool: {
      id: string;
      name: string;
      input: Record<string, unknown>;
      outputLines: string[];
    } | null = null;

    // XML tool_use block parsing state
    let inXmlToolUse = false;
    let xmlToolName = '';
    let xmlToolInput = '';
    let xmlToolResult = '';
    let inXmlToolResult = false;

    for (const line of stdoutLines) {
      // ================================================================
      // XML-style tool use blocks (claude -p newer versions)
      // ================================================================

      // <tool_use> block start
      const xmlToolStartMatch = line.match(/<tool_use>\s*([\w.]+)/i);
      if (xmlToolStartMatch) {
        // Flush accumulated response text as intermediate
        if (responseText.trim()) {
          events.push({
            type: 'text_complete',
            text: responseText.trim(),
            isIntermediate: true,
            turnId: this.currentTurnId || undefined,
          });
          responseText = '';
        }
        inXmlToolUse = true;
        xmlToolName = xmlToolStartMatch[1];
        xmlToolInput = '';
        continue;
      }

      // <tool_use> block end — emit tool_start
      if (inXmlToolUse && line.match(/<\/tool_use>/i)) {
        inXmlToolUse = false;
        const toolId = generateTraceToolUseId();
        // Try to parse xmlToolInput as JSON, fallback to raw text
        let parsedInput: Record<string, unknown> = {};
        try {
          parsedInput = JSON.parse(xmlToolInput.trim());
        } catch {
          parsedInput = { raw_input: xmlToolInput.trim() };
        }
        events.push(this.createToolStart(toolId, xmlToolName, parsedInput));
        this.toolIndex.append(toolId, xmlToolName, parsedInput);
        currentTool = { id: toolId, name: xmlToolName, input: parsedInput, outputLines: [] };
        continue;
      }

      // Accumulate XML tool_use input
      if (inXmlToolUse) {
        xmlToolInput += `${line}\n`;
        continue;
      }

      // <tool_result> block start
      const xmlResultStartMatch = line.match(/<tool_result>/i);
      if (xmlResultStartMatch) {
        inXmlToolResult = true;
        xmlToolResult = '';
        continue;
      }

      // <tool_result> block end — emit tool_result
      if (inXmlToolResult && line.match(/<\/tool_result>/i)) {
        inXmlToolResult = false;
        if (currentTool) {
          events.push(
            this.createToolResult(currentTool.id, currentTool.name, xmlToolResult.trim(), false),
          );
          currentTool = null;
        }
        xmlToolResult = '';
        continue;
      }

      // Accumulate XML tool_result content
      if (inXmlToolResult) {
        xmlToolResult += `${line}\n`;
        continue;
      }

      // ================================================================
      // Text-style tool patterns (older claude -p versions)
      // ================================================================
      // Detect tool use patterns
      const toolStartMatch = matchToolStartPattern(line);
      if (toolStartMatch) {
        // Flush any accumulated response text as intermediate
        if (responseText.trim()) {
          events.push({
            type: 'text_complete',
            text: responseText.trim(),
            isIntermediate: true,
            turnId: this.currentTurnId || undefined,
          });
          responseText = '';
        }
        currentTool = {
          id: generateTraceToolUseId(),
          name: toolStartMatch.name,
          input: toolStartMatch.input,
          outputLines: [],
        };
        events.push(
          this.createToolStart(currentTool.id, currentTool.name, currentTool.input),
        );
        this.toolIndex.append(currentTool.id, currentTool.name, currentTool.input);
        continue;
      }

      // Detect tool result end pattern
      const toolEndMatch = matchToolEndPattern(line);
      if (toolEndMatch && currentTool) {
        events.push(
          this.createToolResult(
            currentTool.id,
            currentTool.name,
            currentTool.outputLines.join('\n').trim() || toolEndMatch.result,
            toolEndMatch.isError,
          ),
        );
        currentTool = null;
        continue;
      }

      // Accumulate tool output or response text
      if (currentTool) {
        currentTool.outputLines.push(line);
      } else {
        responseText += `${line}\n`;
      }
    }

    // Flush remaining tool
    if (currentTool) {
      events.push(
        this.createToolResult(
          currentTool.id,
          currentTool.name,
          currentTool.outputLines.join('\n').trim(),
          false,
        ),
      );
    }

    // Flush final response text
    if (responseText.trim()) {
      events.push({
        type: 'text_complete',
        text: responseText.trim(),
        isIntermediate: false,
        turnId: this.currentTurnId || undefined,
      });
      this.hasFinalResponse = true;
    }

    // Emit complete event
    events.push({ type: 'complete' });

    return events;
  }
}

// ============================================================================
// Tool pattern matching for claude -p output
// ============================================================================

type ToolStartMatch = {
  name: string;
  input: Record<string, unknown>;
};

type ToolEndMatch = {
  result: string;
  isError: boolean;
};

/**
 * Detect tool invocation start patterns in claude -p stdout.
 *
 * Claude -p output format varies, but common patterns include:
 * - "Running command: ..." (Bash)
 * - "Reading file: ..." (Read)
 * - "Writing file: ..." (Write/Edit)
 * - Tool use blocks in markdown-like format
 */
function matchToolStartPattern(line: string): ToolStartMatch | null {
  const trimmed = line.trim();

  // "Running command: <cmd>" or "Executing: <cmd>"
  const cmdMatch = trimmed.match(/^Running command:\s+(.+)$/i) ||
    trimmed.match(/^Executing:\s+(.+)$/i) ||
    trimmed.match(/^Running bash command:\s+(.+)$/i);
  if (cmdMatch) {
    return { name: 'Bash', input: { command: cmdMatch[1] } };
  }

  // "Reading file: <path>" or "Read: <path>"
  const readMatch = trimmed.match(/^Reading file:\s+(.+)$/i) ||
    trimmed.match(/^Read:\s+(.+)$/i);
  if (readMatch) {
    return { name: 'Read', input: { file_path: readMatch[1] } };
  }

  // "Writing file: <path>" or "Edit: <path>"
  const writeMatch = trimmed.match(/^Writing file:\s+(.+)$/i) ||
    trimmed.match(/^Edit:\s+(.+)$/i) ||
    trimmed.match(/^Writing:\s+(.+)$/i);
  if (writeMatch) {
    return { name: 'Edit', input: { file_path: writeMatch[1] } };
  }

  // "Searching for: <query>"
  const searchMatch = trimmed.match(/^Searching for:\s+(.+)$/i) ||
    trimmed.match(/^Search:\s+(.+)$/i);
  if (searchMatch) {
    return { name: 'Search', input: { query: searchMatch[1] } };
  }

  return null;
}

/**
 * Detect tool result end patterns.
 */
function matchToolEndPattern(line: string): ToolEndMatch | null {
  const trimmed = line.trim();

  // "Command completed" / "Command finished" / "Done"
  if (/^Command (completed|finished|done)/i.test(trimmed) || /^Done$/i.test(trimmed)) {
    return { result: trimmed, isError: false };
  }

  // "Command failed" / "Error:" / "exit code: <non-zero>"
  if (/^Command failed/i.test(trimmed) || /^Error:/i.test(trimmed)) {
    return { result: trimmed, isError: true };
  }

  // "File written successfully" / "File read successfully"
  if (/^File (written|read|updated) (successfully|complete)/i.test(trimmed)) {
    return { result: trimmed, isError: false };
  }

  return null;
}
/**
 * Parse claude -p stdout/stderr trace output into AgentEvent[].
 * Convenience wrapper for one-shot replay of persisted runs.
 */
export function parseClaudeStdoutTrace(stdout: string, stderr: string): AgentEvent[] {
  return new ClaudeStdoutAdapter().parseOutput(stdout, stderr)
}
