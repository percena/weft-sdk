import { redactSecrets } from './shared-utils.ts'

export interface ToolOutputPolicyInput {
  callId: string
  toolName: string
  text: string
  intent?: string
}

export type ToolOutputPolicyAction = 'inline' | 'artifact'

export interface ToolOutputReceipt {
  callId: string
  toolName: string
  action: ToolOutputPolicyAction
  byteLength: number
  redacted: boolean
  truncated: boolean
  inlineText?: string
  summary?: string
  artifactRef?: string
  intent?: string
}

export interface ToolOutputPolicyOptions {
  maxInlineBytes?: number
  artifactRef?: (input: ToolOutputPolicyInput) => string
  summarizer?: (input: { text: string; source: ToolOutputPolicyInput }) => string
}

export interface ToolOutputPolicy {
  process(input: ToolOutputPolicyInput): ToolOutputReceipt
}

const DEFAULT_MAX_INLINE_BYTES = 60 * 1024

export function createToolOutputPolicy(
  options: ToolOutputPolicyOptions = {},
): ToolOutputPolicy {
  const maxInlineBytes = options.maxInlineBytes ?? DEFAULT_MAX_INLINE_BYTES

  return {
    process(input) {
      const redaction = redactSecrets(input.text)
      const byteLength = Buffer.byteLength(redaction.text, 'utf8')
      const shouldInline = byteLength <= maxInlineBytes

      if (shouldInline) {
        return {
          callId: input.callId,
          toolName: input.toolName,
          action: 'inline',
          byteLength,
          redacted: redaction.redacted,
          truncated: false,
          inlineText: redaction.text,
          ...(input.intent ? { intent: input.intent } : {}),
        }
      }

      const truncated = truncateByBytes(redaction.text, maxInlineBytes)
      const source = { ...input, text: redaction.text }
      const summary = options.summarizer
        ? options.summarizer({ text: truncated, source })
        : truncated

      return {
        callId: input.callId,
        toolName: input.toolName,
        action: 'artifact',
        byteLength,
        redacted: redaction.redacted,
        truncated: true,
        summary,
        artifactRef: options.artifactRef?.(input) ?? `tool-output://${input.callId}`,
        ...(input.intent ? { intent: input.intent } : {}),
      }
    },
  }
}

function truncateByBytes(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, 'utf8')
  if (buffer.byteLength <= maxBytes) return text
  return buffer.subarray(0, maxBytes).toString('utf8')
}
