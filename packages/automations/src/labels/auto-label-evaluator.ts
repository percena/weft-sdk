import type { AutoLabelConfig, AutoLabelMatch } from './auto-label-types.ts'
import { normalizeNumberValue } from './auto-label-normalize.ts'

const MAX_MATCHES_PER_MESSAGE = 10
const CODE_BLOCK_PATTERN = /```[\s\S]*?```|`[^`]+`/g

export function evaluateAutoLabels(
  text: string,
  configs: AutoLabelConfig[],
): AutoLabelMatch[] {
  const stripped = text.replace(CODE_BLOCK_PATTERN, '')
  const matches: AutoLabelMatch[] = []
  const seen = new Set<string>()

  for (const config of configs) {
    for (const rule of config.rules) {
      if (matches.length >= MAX_MATCHES_PER_MESSAGE) return matches

      let flags = rule.flags ?? 'gi'
      if (!flags.includes('g')) flags = `g${flags}`

      let regex: RegExp
      try {
        regex = new RegExp(rule.pattern, flags)
      } catch {
        continue
      }

      let match: RegExpExecArray | null
      while ((match = regex.exec(stripped)) !== null) {
        if (matches.length >= MAX_MATCHES_PER_MESSAGE) return matches

        let value: string
        if (rule.valueTemplate) {
          value = substituteCaptures(rule.valueTemplate, match)
        } else {
          value = match[1] ?? match[0]!
        }

        value = value.trim()
        if (!value) continue

        const dedupeKey = `${config.labelId}::${value}`
        if (seen.has(dedupeKey)) continue
        seen.add(dedupeKey)

        matches.push({
          labelId: config.labelId,
          value: normalizeNumberValue(value),
          matchedText: match[0]!,
        })
      }
    }
  }

  return matches
}

function substituteCaptures(template: string, match: RegExpExecArray): string {
  return template.replace(/\$(\d+)/g, (_, index) => {
    const i = parseInt(index, 10)
    return match[i] ?? ''
  })
}
