/**
 * Shared infrastructure for offline trace parsers.
 *
 * Self-contained on purpose: the live adapters in @weft/adapter evolved a
 * different ToolIndex/BaseEventAdapter API (interceptors, session metadata),
 * while trace replay needs only the original append-only index and per-turn
 * state maps. Keeping a local copy avoids coupling browser-safe replay code
 * to the Node-oriented adaptor internals.
 */

export function generateTraceTurnId(): string {
  return `turn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

export function generateTraceToolUseId(): string {
  return `tool-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

/* ── ToolIndex — append-only index for tool_use_id matching ── */

export type TraceToolEntry = {
  id: string
  name: string
  input?: Record<string, unknown>
  matched: boolean
}

export class TraceToolIndex {
  private index: Map<string, TraceToolEntry> = new Map()

  append(id: string, name: string, input?: Record<string, unknown>): void {
    this.index.set(id, { id, name, input, matched: false })
  }

  find(id: string): TraceToolEntry | undefined {
    return this.index.get(id)
  }

  markMatched(id: string): void {
    const entry = this.index.get(id)
    if (entry) {
      entry.matched = true
    }
  }

  isMatched(id: string): boolean {
    return this.index.get(id)?.matched ?? false
  }

  has(id: string): boolean {
    return this.index.has(id)
  }

  clear(): void {
    this.index.clear()
  }

  /** Get all unmatched tool starts (for detecting orphaned tool calls) */
  unmatched(): TraceToolEntry[] {
    return Array.from(this.index.values()).filter((entry) => !entry.matched)
  }
}

/* ── Read pattern detection — classify bash commands as file reads ── */

export type TraceReadCommandInfo = {
  filePath: string
  startLine?: number
  endLine?: number
  originalCommand: string
}

const READ_PATTERNS: Array<{
  regex: RegExp
  extract: (match: RegExpMatchArray) => TraceReadCommandInfo
}> = [
  // cat file
  {
    regex: /^cat\s+['"]?([^'"\s]+)['"]?\s*$/,
    extract: (m) => ({ filePath: m[1], originalCommand: m[0] }),
  },
  // head -n N file / head -N file
  {
    regex: /^head\s+-n\s+(\d+)\s+['"]?([^'"\s]+)['"]?\s*$/,
    extract: (m) => ({
      filePath: m[2],
      endLine: parseInt(m[1], 10),
      originalCommand: m[0],
    }),
  },
  {
    regex: /^head\s+-(\d+)\s+['"]?([^'"\s]+)['"]?\s*$/,
    extract: (m) => ({
      filePath: m[2],
      endLine: parseInt(m[1], 10),
      originalCommand: m[0],
    }),
  },
  // tail -n N file
  {
    regex: /^tail\s+-n\s+(\d+)\s+['"]?([^'"\s]+)['"]?\s*$/,
    extract: (m) => ({
      filePath: m[2],
      startLine: -parseInt(m[1], 10), // negative = last N lines
      originalCommand: m[0],
    }),
  },
  // sed -n 'start,end' file
  {
    regex: /^sed\s+-n\s+'(\d+),(\d+)p'\s+['"]?([^'"\s]+)['"]?\s*$/,
    extract: (m) => ({
      filePath: m[3],
      startLine: parseInt(m[1], 10),
      endLine: parseInt(m[2], 10),
      originalCommand: m[0],
    }),
  },
  // sed -n 'startp' file
  {
    regex: /^sed\s+-n\s+'(\d+)p'\s+['"]?([^'"\s]+)['"]?\s*$/,
    extract: (m) => ({
      filePath: m[2],
      startLine: parseInt(m[1], 10),
      endLine: parseInt(m[1], 10),
      originalCommand: m[0],
    }),
  },
]

/**
 * Classify a bash command as a file read operation.
 * Returns TraceReadCommandInfo if the command reads a file, null otherwise.
 */
export function parseTraceReadCommand(command: string): TraceReadCommandInfo | null {
  // Strip leading "bash -lc" or "bash -c" wrapper
  const stripped = command.replace(/^bash\s+-[lc]+\s+/, '').trim()
  for (const pattern of READ_PATTERNS) {
    const match = stripped.match(pattern.regex)
    if (match) {
      return pattern.extract(match)
    }
  }
  return null
}
