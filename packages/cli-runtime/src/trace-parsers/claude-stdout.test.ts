/**
 * ClaudeStdoutAdapter unit tests — verify claude -p stdout → AgentEvent mapping.
 */

import { describe, it, expect } from "vitest";
import { ClaudeStdoutAdapter } from './claude-stdout.ts'

describe("ClaudeStdoutAdapter", () => {
  it("maps plain text stdout to text_complete", () => {
    const adapter = new ClaudeStdoutAdapter();
    const events = adapter.parseOutput("Hello, this is the response.", "");

    const textEvent = events.find(e => e.type === 'text_complete');
    if (textEvent?.type === 'text_complete') {
      expect(textEvent.text).toBe("Hello, this is the response.");
      expect(textEvent.isIntermediate).toBe(false);
    }
  });

  it("maps stderr rate limit errors to error event", () => {
    const adapter = new ClaudeStdoutAdapter();
    const events = adapter.parseOutput("", "Error: rate_limited\n429 Too Many Requests");

    const errorEvents = events.filter(e => e.type === 'error');
    expect(errorEvents.length).toBeGreaterThan(0);
    if (errorEvents[0]?.type === 'error') {
      expect(errorEvents[0].message).toContain('Rate limited');
    }
  });

  it("maps stderr auth errors to error event", () => {
    const adapter = new ClaudeStdoutAdapter();
    const events = adapter.parseOutput("", "Authentication error: invalid_api_key");

    const errorEvent = events.find(e => e.type === 'error');
    if (errorEvent?.type === 'error') {
      expect(errorEvent.message).toContain('Authentication');
    }
  });

  it("maps text tool patterns to tool_start", () => {
    const adapter = new ClaudeStdoutAdapter();
    const events = adapter.parseOutput("Running command: npm install\nDone\n", "");

    const toolStart = events.find(e => e.type === 'tool_start');
    const toolResult = events.find(e => e.type === 'tool_result');

    if (toolStart?.type === 'tool_start') {
      expect(toolStart.toolName).toBe('Bash');
    }
    // "Done" triggers tool_result
    expect(toolResult).toBeDefined();
  });

  it("maps XML <tool_use> blocks to tool_start", () => {
    const adapter = new ClaudeStdoutAdapter();
    const events = adapter.parseOutput(
      "<tool_use> Bash\n{\"command\": \"ls\"}\n</tool_use>\n<tool_result>\nfile1\nfile2\n</tool_result>",
      ""
    );

    const toolStart = events.find(e => e.type === 'tool_start');
    const toolResult = events.find(e => e.type === 'tool_result');

    expect(toolStart).toBeDefined();
    if (toolStart?.type === 'tool_start') {
      expect(toolStart.toolName).toBe('Bash');
    }
    expect(toolResult).toBeDefined();
  });

  it("flushes intermediate text before tool pattern", () => {
    const adapter = new ClaudeStdoutAdapter();
    const events = adapter.parseOutput(
      "Let me check the files.\nRunning command: ls -la\nCommand completed\nHere's what I found.",
      ""
    );

    const textCompletes = events.filter(e => e.type === 'text_complete');
    // First text before tool should be intermediate
    const intermediate = textCompletes.find(e => e.type === 'text_complete' && e.isIntermediate);
    expect(intermediate).toBeDefined();
    // Last text after tool should be final
    const final = textCompletes.find(e => e.type === 'text_complete' && !e.isIntermediate);
    expect(final).toBeDefined();
  });

  it("maps less important stderr as status", () => {
    const adapter = new ClaudeStdoutAdapter();
    const events = adapter.parseOutput("", "Warning: deprecated API\nInfo: using cache");

    const statusEvents = events.filter(e => e.type === 'status');
    expect(statusEvents.length).toBeGreaterThanOrEqual(1);
  });

  it("returns empty events for empty input", () => {
    const adapter = new ClaudeStdoutAdapter();
    const events = adapter.parseOutput("", "");
    // Should only have complete event
    expect(events.filter(e => e.type !== 'complete').length).toBe(0);
  });

  it("always emits complete event", () => {
    const adapter = new ClaudeStdoutAdapter();
    const events = adapter.parseOutput("Some text", "");
    expect(events.some(e => e.type === 'complete')).toBe(true);
  });
});