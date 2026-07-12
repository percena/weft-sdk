import type { AgentEvent } from '@weft/core'

function parseJsonLine(line: string): unknown | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  try {
    return JSON.parse(trimmed)
  } catch {
    return null
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {}
}

function getText(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function normalizeUsage(raw: Record<string, unknown>): Extract<AgentEvent, { type: 'complete' }>['usage'] {
  const inputTokens = typeof raw.input_tokens === 'number' ? raw.input_tokens :
    typeof raw.inputTokens === 'number' ? raw.inputTokens : 0
  const outputTokens = typeof raw.output_tokens === 'number' ? raw.output_tokens :
    typeof raw.outputTokens === 'number' ? raw.outputTokens : 0
  return { inputTokens, outputTokens }
}

/**
 * A7: extract the provider session id from a raw CLI JSON line, so the CLI
 * fallback can resume the conversation on the next turn (`claude -p --resume
 * <id>` / `codex exec resume <id>`). Claude surfaces `session_id` on
 * `system:init` and `result`; codex exec surfaces the thread/session id on
 * `thread.started` / `session.started`.
 */
export function extractCliProviderSessionId(
  provider: 'claude' | 'codex',
  line: string,
): string | undefined {
  const payload = asRecord(parseJsonLine(line))
  const type = getText(payload.type)
  if (!type) return undefined

  if (provider === 'claude') {
    if (type === 'system' && payload.subtype === 'init') return getText(payload.session_id)
    if (type === 'result') return getText(payload.session_id)
    return undefined
  }

  if (type === 'thread.started' || type === 'thread_started') {
    return getText(payload.thread_id) ?? getText(payload.threadId)
  }
  if (type === 'session.started' || type === 'session_started') {
    return getText(payload.session_id) ?? getText(asRecord(payload.session).id)
  }
  return undefined
}

export function mapClaudeStreamJsonLine(line: string): AgentEvent[] {
  const payload = asRecord(parseJsonLine(line))
  const type = getText(payload.type)
  if (!type) return []

  if (type === 'system' && payload.subtype === 'init') {
    return [{ type: 'status', message: 'Claude session initialized' }]
  }

  if (type === 'stream_event') {
    const event = asRecord(payload.event)
    if (event.type === 'content_block_delta') {
      const delta = asRecord(event.delta)
      const text = getText(delta.text)
      if (text) {
        return [{
          type: 'text_delta',
          text,
          turnId: getText(asRecord(payload.message).id) ?? getText(payload.message_id) ?? 'msg_1',
        }]
      }
    }
    return []
  }

  if (type === 'assistant') {
    const message = asRecord(payload.message)
    const turnId = getText(message.id)
    const content = Array.isArray(message.content) ? message.content.map(asRecord) : []
    const events: AgentEvent[] = []

    for (const item of content) {
      if (item.type === 'tool_use') {
        const toolUseId = getText(item.id)
        const toolName = getText(item.name)
        if (toolUseId && toolName) {
          events.push({
            type: 'tool_start',
            toolName,
            toolUseId,
            input: asRecord(item.input),
            turnId,
          })
        }
      } else if (item.type === 'text') {
        const text = getText(item.text)
        if (text) {
          events.push({
            type: 'text_complete',
            text,
            isIntermediate: message.stop_reason === 'tool_use',
            turnId,
          })
        }
      }
    }
    return events
  }

  if (type === 'result') {
    if (payload.subtype && payload.subtype !== 'success') {
      return [{ type: 'error', message: `Claude finished with ${String(payload.subtype)}` }, { type: 'complete' }]
    }
    return [{ type: 'complete', usage: normalizeUsage(asRecord(payload.usage)) }]
  }

  if (type === 'error') {
    return [{ type: 'error', message: getText(payload.message) ?? 'Claude stream error' }]
  }

  return []
}

export function mapCodexExecJsonLine(line: string): AgentEvent[] {
  const payload = asRecord(parseJsonLine(line))
  const type = getText(payload.type)
  if (!type) return []

  if (type === 'session.started' || type === 'session_started' || type === 'thread.started' || type === 'thread_started') {
    return [{ type: 'status', message: 'Codex session initialized' }]
  }

  if (type === 'turn.started' || type === 'turn_started') {
    return [{ type: 'status', message: 'Codex turn started' }]
  }

  if (type === 'item.started' || type === 'item_started') {
    const item = asRecord(payload.item)
    const itemType = getText(item.type)
    const turnId = getText(payload.turn_id) ?? getText(payload.turnId)
    if (itemType === 'command_execution' || itemType === 'commandExecution') {
      const toolUseId = getText(item.id) ?? getText(payload.item_id) ?? `tool-${Date.now()}`
      const command = getText(item.command)
      return [{
        type: 'tool_start',
        toolName: 'Bash',
        toolUseId,
        input: command ? { command } : asRecord(item.arguments),
        turnId,
      }]
    }
    if (itemType === 'web_search') {
      const toolUseId = getText(item.id) ?? getText(payload.item_id) ?? `tool-${Date.now()}`
      return [{
        type: 'tool_start',
        toolName: 'webSearch',
        toolUseId,
        input: { query: getText(item.query) },
        turnId,
      }]
    }
    if (itemType === 'mcp_tool_call') {
      const toolUseId = getText(item.id) ?? getText(payload.item_id) ?? `tool-${Date.now()}`
      return [{
        type: 'tool_start',
        toolName: `${getText(item.server) ?? 'mcp'}.${getText(item.tool) ?? 'tool'}`,
        toolUseId,
        input: asRecord(item.arguments),
        turnId,
      }]
    }
    if (itemType === 'file_change') {
      const toolUseId = getText(item.id) ?? getText(payload.item_id) ?? `tool-${Date.now()}`
      return [{
        type: 'tool_start',
        toolName: 'fileChange',
        toolUseId,
        input: { changes: item.changes },
        turnId,
      }]
    }
    return []
  }

  if (type === 'item.completed' || type === 'item_completed') {
    const item = asRecord(payload.item)
    const itemType = getText(item.type)
    const turnId = getText(payload.turn_id) ?? getText(payload.turnId)
    if (itemType === 'agent_message' || itemType === 'agentMessage') {
      const text = getText(item.text) ?? getText(item.message)
      return text ? [{
        type: 'text_complete',
        text,
        isIntermediate: false,
        turnId: turnId ?? getText(item.id),
      }] : []
    }
    if (itemType === 'reasoning') {
      const text = getText(item.text) ?? getText(item.summary)
      return text ? [{ type: 'reasoning', text, turnId }] : []
    }
    if (itemType === 'command_execution' || itemType === 'commandExecution') {
      const toolUseId = getText(item.id) ?? getText(payload.item_id) ?? `tool-${Date.now()}`
      const exitCode = typeof item.exit_code === 'number' ? item.exit_code :
        typeof item.exitCode === 'number' ? item.exitCode : 0
      return [{
        type: 'tool_result',
        toolName: 'Bash',
        toolUseId,
        result: getText(item.aggregated_output) ?? getText(item.aggregatedOutput) ?? getText(item.output) ?? '',
        isError: exitCode !== 0 || item.is_error === true,
        turnId,
      }]
    }
    if (itemType === 'web_search') {
      const toolUseId = getText(item.id) ?? getText(payload.item_id) ?? `tool-${Date.now()}`
      return [{
        type: 'tool_result',
        toolName: 'webSearch',
        toolUseId,
        result: getText(item.query) ?? '',
        isError: false,
        turnId,
      }]
    }
    if (itemType === 'mcp_tool_call') {
      const toolUseId = getText(item.id) ?? getText(payload.item_id) ?? `tool-${Date.now()}`
      const errorObj = asRecord(item.error)
      const isError = Boolean(item.error)
      const result = isError
        ? (getText(errorObj.message) ?? 'MCP tool error')
        : (typeof item.result === 'string' ? item.result : JSON.stringify(item.result ?? ''))
      return [{
        type: 'tool_result',
        toolName: `${getText(item.server) ?? 'mcp'}.${getText(item.tool) ?? 'tool'}`,
        toolUseId,
        result,
        isError,
        turnId,
      }]
    }
    if (itemType === 'file_change') {
      const toolUseId = getText(item.id) ?? getText(payload.item_id) ?? `tool-${Date.now()}`
      return [{
        type: 'tool_result',
        toolName: 'fileChange',
        toolUseId,
        result: JSON.stringify(item.changes ?? []),
        isError: getText(item.status) === 'failed',
        turnId,
      }]
    }
    if (itemType === 'todo_list') {
      // Surface the agent's running to-do list as reasoning (no dedicated
      // timeline item type); the plan item + turn/plan/updated path is the
      // richer app-server representation.
      const items = Array.isArray(item.items) ? item.items : []
      const text = items
        .map((entry: unknown) => getText(asRecord(entry).text))
        .filter((line): line is string => Boolean(line))
        .join('\n')
      return text ? [{ type: 'reasoning', text, turnId }] : []
    }
    if (itemType === 'error') {
      return [{ type: 'error', message: getText(item.message) ?? 'Codex item error' }]
    }
    return []
  }

  if (type === 'agent_message_delta' || type === 'message_delta' || type === 'response.output_text.delta') {
    const text = getText(payload.delta) ?? getText(payload.text)
    return text ? [{ type: 'text_delta', text }] : []
  }

  if (type === 'agent_message' || type === 'message' || type === 'response.output_text.done') {
    const text = getText(payload.message) ?? getText(payload.text)
    return text ? [{ type: 'text_complete', text, isIntermediate: false }] : []
  }

  if (type === 'exec_command_begin' || type === 'tool_call_begin') {
    const toolUseId = getText(payload.call_id) ?? getText(payload.id) ?? `tool-${Date.now()}`
    const command = getText(payload.command)
    return [{
      type: 'tool_start',
      toolName: getText(payload.tool_name) ?? 'Bash',
      toolUseId,
      input: command ? { command } : asRecord(payload.arguments),
    }]
  }

  if (type === 'exec_command_end' || type === 'tool_call_end') {
    const toolUseId = getText(payload.call_id) ?? getText(payload.id) ?? `tool-${Date.now()}`
    const exitCode = typeof payload.exit_code === 'number' ? payload.exit_code : 0
    return [{
      type: 'tool_result',
      toolName: getText(payload.tool_name) ?? 'Bash',
      toolUseId,
      result: getText(payload.output) ?? getText(payload.result) ?? '',
      isError: exitCode !== 0 || payload.is_error === true,
    }]
  }

  if (type === 'turn_completed' || type === 'turn.completed' || type === 'task_complete' || type === 'response.completed') {
    return [{ type: 'complete', usage: normalizeUsage(asRecord(payload.usage)) }]
  }

  if (type === 'error') {
    return [{ type: 'error', message: getText(payload.message) ?? 'Codex stream error' }]
  }

  return []
}
