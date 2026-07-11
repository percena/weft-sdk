/**
 * TraceEventAdapter — abstract base class for offline trace parsers.
 *
 * Provides shared state management for replaying persisted provider output:
 * - commandOutput: accumulate streaming deltas into final tool result
 * - readCommands: classify bash commands as file reads
 * - blockReasons: track permission-declined tool results
 * - turn lifecycle: reset per-turn state on startTurn()
 *
 * Subclasses implement provider-specific event dispatch.
 */

import type { AgentEvent } from '@weft/core'
import {
  TraceToolIndex,
  parseTraceReadCommand,
  generateTraceTurnId,
  type TraceReadCommandInfo,
} from './support.ts'

export abstract class TraceEventAdapter {
  protected turnIndex: number = 0
  protected currentTurnId: string | null = null

  // Shared state maps — reset on each turn
  protected commandOutput: Map<string, string> = new Map()
  protected readCommands: Map<string, TraceReadCommandInfo> = new Map()
  protected blockReasons: Map<string, string> = new Map()
  protected toolIndex = new TraceToolIndex()

  /**
   * Start a new turn — resets shared state and calls subclass hook.
   */
  startTurn(turnId?: string): void {
    this.turnIndex++
    this.commandOutput.clear()
    this.readCommands.clear()
    this.blockReasons.clear()
    this.toolIndex.clear()
    this.currentTurnId = turnId || generateTraceTurnId()
    this.onTurnStart()
  }

  /**
   * Subclass hook called during startTurn() for resetting provider-specific state.
   */
  protected abstract onTurnStart(): void

  setBlockReason(id: string, reason: string): void {
    this.blockReasons.set(id, reason)
  }

  protected consumeBlockReason(...keys: string[]): string | undefined {
    for (const key of keys) {
      const reason = this.blockReasons.get(key)
      if (reason !== undefined) {
        this.blockReasons.delete(key)
        return reason
      }
    }
    return undefined
  }

  protected classifyReadCommand(id: string, command: string): TraceReadCommandInfo | null {
    const readInfo = parseTraceReadCommand(command)
    if (readInfo) {
      this.readCommands.set(id, readInfo)
    }
    return readInfo
  }

  protected consumeReadCommand(id: string): TraceReadCommandInfo | undefined {
    const info = this.readCommands.get(id)
    if (info) {
      this.readCommands.delete(id)
    }
    return info
  }

  accumulateOutput(id: string, delta: string): void {
    const current = this.commandOutput.get(id) || ''
    this.commandOutput.set(id, current + delta)
  }

  protected consumeOutput(id: string): string | undefined {
    const output = this.commandOutput.get(id)
    if (output !== undefined) {
      this.commandOutput.delete(id)
    }
    return output
  }

  protected createToolStart(
    id: string,
    toolName: string,
    input: Record<string, unknown>,
    intent?: string,
    displayName?: string,
    parentToolUseId?: string,
  ): AgentEvent {
    return {
      type: 'tool_start',
      toolName,
      toolUseId: id,
      input,
      intent,
      displayName,
      turnId: this.currentTurnId || undefined,
      parentToolUseId,
    }
  }

  protected createToolResult(
    id: string,
    toolName: string,
    result: string,
    isError: boolean,
    parentToolUseId?: string,
  ): AgentEvent {
    return {
      type: 'tool_result',
      toolUseId: id,
      toolName,
      result,
      isError,
      turnId: this.currentTurnId || undefined,
      parentToolUseId,
    }
  }

  protected createReadToolStart(
    id: string,
    readInfo: TraceReadCommandInfo,
    intent?: string,
  ): AgentEvent {
    return this.createToolStart(
      id,
      'Read',
      {
        file_path: readInfo.filePath,
        offset: readInfo.startLine,
        limit: readInfo.endLine
          ? readInfo.endLine - (readInfo.startLine || 1) + 1
          : undefined,
        _command: readInfo.originalCommand,
      },
      intent,
      'Read File',
    )
  }

  /**
   * Build an MCP tool name from server and tool names.
   */
  protected buildMcpToolName(serverName: string, toolName: string): string {
    // If the tool name already has mcp__ prefix, keep it
    if (toolName.startsWith('mcp__')) return toolName
    return `mcp__${serverName}__${toolName}`
  }
}
