export type DiffStats = {
  additions: number
  deletions: number
}

function splitComparableLines(value: string): string[] {
  if (!value) return []
  const lines = value.split(/\r?\n/)
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop()
  }
  return lines
}

function lcsLength(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0
  const previous = new Array<number>(b.length + 1).fill(0)
  const current = new Array<number>(b.length + 1).fill(0)

  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = a[i - 1] === b[j - 1]
        ? previous[j - 1] + 1
        : Math.max(previous[j], current[j - 1])
    }
    previous.splice(0, previous.length, ...current)
    current.fill(0)
  }

  return previous[b.length] ?? 0
}

export function getTextDiffStats(oldText: string, newText: string): DiffStats {
  const oldLines = splitComparableLines(oldText)
  const newLines = splitComparableLines(newText)
  const common = lcsLength(oldLines, newLines)

  return {
    additions: Math.max(0, newLines.length - common),
    deletions: Math.max(0, oldLines.length - common),
  }
}

export function getUnifiedDiffStats(_diff: string, _path?: string): { added: number; removed: number; additions: number; deletions: number; files: number } {
  let additions = 0
  let deletions = 0
  let files = 0

  for (const line of _diff.split(/\r?\n/)) {
    if (line.startsWith('diff --git ') || line.startsWith('+++ ')) {
      files += 1
      continue
    }
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@')) {
      continue
    }
    if (line.startsWith('+')) additions += 1
    if (line.startsWith('-')) deletions += 1
  }

  return { added: additions, removed: deletions, additions, deletions, files }
}
