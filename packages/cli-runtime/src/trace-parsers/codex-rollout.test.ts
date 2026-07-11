/**
 * CodexRolloutAdapter unit tests — verify rollout JSONL → AgentEvent mapping.
 * Covers the key rollout JSONL → AgentEvent mapping rules.
 */

import { describe, it, expect } from "vitest";
import { CodexRolloutAdapter } from './codex-rollout.ts'

function makeJsonlLine(obj: Record<string, unknown>): string {
  return JSON.stringify(obj);
}

function makeRollout(lines: Record<string, unknown>[]): string {
  return lines.map(makeJsonlLine).join('\n');
}

describe("CodexRolloutAdapter", () => {
  it("maps exec_command_begin+end to tool_start+tool_result (Bash)", () => {
    const adapter = new CodexRolloutAdapter();
    const events = adapter.parseRollout(makeRollout([
      { type: "exec_command_begin", call_id: "call_1", command: "ls -la", cwd: "/tmp" },
      { type: "exec_command_end", call_id: "call_1", exit_code: 0, stdout: "file1\nfile2" },
    ]));

    const toolStart = events.find(e => e.type === 'tool_start');
    const toolResult = events.find(e => e.type === 'tool_result');

    expect(toolStart).toBeDefined();
    if (toolStart?.type === 'tool_start') {
      expect(toolStart.toolName).toBe('Bash');
      expect(toolStart.toolUseId).toBe('call_1');
      expect(toolStart.input).toHaveProperty('command');
    }

    expect(toolResult).toBeDefined();
    if (toolResult?.type === 'tool_result') {
      expect(toolResult.toolUseId).toBe('call_1');
      expect(toolResult.isError).toBe(false);
    }
  });

  it("maps exec_command with non-zero exit code as error", () => {
    const adapter = new CodexRolloutAdapter();
    const events = adapter.parseRollout(makeRollout([
      { type: "exec_command_begin", call_id: "call_2", command: "bad_cmd" },
      { type: "exec_command_end", call_id: "call_2", exit_code: 1 },
    ]));

    const toolResult = events.find(e => e.type === 'tool_result');
    if (toolResult?.type === 'tool_result') {
      expect(toolResult.isError).toBe(true);
    }
  });

  it("maps reasoning to text_complete { isIntermediate: true }", () => {
    const adapter = new CodexRolloutAdapter();
    const events = adapter.parseRollout(makeRollout([
      { type: "agent_reasoning", text: "I should check the files first" },
    ]));

    const textEvent = events.find(e => e.type === 'text_complete');
    if (textEvent?.type === 'text_complete') {
      expect(textEvent.isIntermediate).toBe(true);
      expect(textEvent.text).toBe("I should check the files first");
    }
  });

  it("maps agent_reasoning_delta to text_delta", () => {
    const adapter = new CodexRolloutAdapter();
    const events = adapter.parseRollout(makeRollout([
      { type: "agent_reasoning_delta", delta: "Thinking..." },
    ]));

    const deltaEvent = events.find(e => e.type === 'text_delta');
    if (deltaEvent?.type === 'text_delta') {
      expect(deltaEvent.text).toBe("Thinking...");
    }
  });

  it("deduplicates response_item and event_msg by ID", () => {
    const adapter = new CodexRolloutAdapter();
    const events = adapter.parseRollout(makeRollout([
      { type: "event_msg", id: "msg_1", role: "assistant", message: "Hello world" },
      { type: "response_item", id: "msg_1", role: "assistant", content: [{ type: "text", text: "Hello world" }] },
    ]));

    // Only one text_complete should appear (event_msg first, response_item deduplicated)
    const textCompletes = events.filter(e => e.type === 'text_complete');
    expect(textCompletes.length).toBe(1);
  });

  it("filters synthetic environment messages", () => {
    const adapter = new CodexRolloutAdapter();
    const events = adapter.parseRollout(makeRollout([
      { type: "response_item", id: "env_1", role: "user", content: [{ type: "text", text: "<environment>Python 3.11 is not available</environment>" }] },
    ]));

    // No events should be emitted for synthetic messages
    expect(events.filter(e => e.type !== 'complete').length).toBe(0);
  });

  it("maps apply_patch to tool_start { Edit } + tool_result", () => {
    const adapter = new CodexRolloutAdapter();
    const events = adapter.parseRollout(makeRollout([
      { type: "patch_apply_begin", call_id: "patch_1", changes: { "src/App.tsx": { unified_diff: "@@ -1 +1 @@\n-old\n+new" } } },
      { type: "patch_apply_end", call_id: "patch_1", success: true, stdout: "Applied patch" },
    ]));

    const toolStart = events.find(e => e.type === 'tool_start');
    const toolResult = events.find(e => e.type === 'tool_result');

    if (toolStart?.type === 'tool_start') {
      expect(toolStart.toolName).toBe('Edit');
    }
    if (toolResult?.type === 'tool_result') {
      expect(toolResult.isError).toBe(false);
    }
  });

  it("maps write_stdin to status event", () => {
    const adapter = new CodexRolloutAdapter();
    const events = adapter.parseRollout(makeRollout([
      { type: "write_stdin", content: "y" },
    ]));

    const statusEvent = events.find(e => e.type === 'status');
    expect(statusEvent).toBeDefined();
    if (statusEvent?.type === 'status') {
      expect(statusEvent.message).toContain('Terminal');
    }
  });

  it("maps function_call_output as independent event", () => {
    const adapter = new CodexRolloutAdapter();
    const events = adapter.parseRollout(makeRollout([
      { type: "response_item", id: "resp_1", role: "assistant", content: [{ type: "tool_use", id: "fc_1", name: "Bash", input: { command: "ls" } }] },
      { type: "function_call_output", call_id: "fc_1", output: "file1\nfile2", is_error: false },
    ]));

    const toolStart = events.find(e => e.type === 'tool_start');
    const toolResult = events.find(e => e.type === 'tool_result');
    expect(toolStart).toBeDefined();
    expect(toolResult).toBeDefined();
  });

  it("emits complete event at end of rollout", () => {
    const adapter = new CodexRolloutAdapter();
    const events = adapter.parseRollout(makeRollout([
      { type: "task_complete", last_agent_message: "Done" },
    ]));

    expect(events.some(e => e.type === 'complete')).toBe(true);
  });

  it("surfaces a top-level error event as a status event instead of dropping it", () => {
    const adapter = new CodexRolloutAdapter();
    const events = adapter.parseRollout(makeRollout([
      { type: "error", error: { message: "upstream 500" } },
    ]));

    const statusEvent = events.find(e => e.type === 'status');
    expect(statusEvent).toBeDefined();
    if (statusEvent?.type === 'status') {
      expect(statusEvent.message).toBe('upstream 500');
    }
  });

  it("returns empty events array for empty input", () => {
    const adapter = new CodexRolloutAdapter();
    const events = adapter.parseRollout("");
    expect(events.length).toBe(0);
  });

  it("classifies cat command as Read tool", () => {
    const adapter = new CodexRolloutAdapter();
    const events = adapter.parseRollout(makeRollout([
      { type: "exec_command_begin", call_id: "read_1", command: "cat src/App.tsx" },
      { type: "exec_command_end", call_id: "read_1", exit_code: 0, stdout: "content here" },
    ]));

    const toolStart = events.find(e => e.type === 'tool_start');
    if (toolStart?.type === 'tool_start') {
      expect(toolStart.toolName).toBe('Read');
    }
  });

  it("strips shell envelope from output", () => {
    const adapter = new CodexRolloutAdapter();
    const events = adapter.parseRollout(makeRollout([
      { type: "exec_command_begin", call_id: "env_1", command: "ls" },
      { type: "exec_command_end", call_id: "env_1", exit_code: 0, stdout: "[stdout] real output" },
    ]));

    const toolResult = events.find(e => e.type === 'tool_result');
    if (toolResult?.type === 'tool_result') {
      expect(toolResult.result).not.toContain('[stdout]');
      expect(toolResult.result).toContain('real output');
    }
  });
});