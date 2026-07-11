export type SecondaryLlmPolicyDenyReason =
  | 'model_not_allowed'
  | 'input_too_large'
  | 'output_too_large'
  | 'attachment_path_not_allowed'

export interface SecondaryLlmCallPolicyOptions {
  allowedModels: string[]
  maxInputBytes: number
  maxOutputBytes: number
  allowedAttachmentRoots?: string[]
}

export interface SecondaryLlmAuthorizeInput {
  model: string
  prompt: string
  maxOutputBytes?: number
  attachments?: string[]
}

export type SecondaryLlmAuthorization =
  | {
    decision: 'allow'
    model: string
    inputBytes: number
    maxOutputBytes: number
  }
  | {
    decision: 'deny'
    reason: SecondaryLlmPolicyDenyReason
    model: string
  }

export interface SecondaryLlmCallPolicy {
  authorize(input: SecondaryLlmAuthorizeInput): SecondaryLlmAuthorization
}

export function createSecondaryLlmCallPolicy(
  options: SecondaryLlmCallPolicyOptions,
): SecondaryLlmCallPolicy {
  const allowedModels = new Set(options.allowedModels)
  const allowedAttachmentRoots = options.allowedAttachmentRoots ?? []

  return {
    authorize(input) {
      if (!allowedModels.has(input.model)) {
        return { decision: 'deny', reason: 'model_not_allowed', model: input.model }
      }

      const inputBytes = Buffer.byteLength(input.prompt, 'utf8')
      if (inputBytes > options.maxInputBytes) {
        return { decision: 'deny', reason: 'input_too_large', model: input.model }
      }

      const maxOutputBytes = input.maxOutputBytes ?? options.maxOutputBytes
      if (maxOutputBytes > options.maxOutputBytes) {
        return { decision: 'deny', reason: 'output_too_large', model: input.model }
      }

      if ((input.attachments ?? []).some(path => !isAllowedAttachmentPath(path, allowedAttachmentRoots))) {
        return { decision: 'deny', reason: 'attachment_path_not_allowed', model: input.model }
      }

      return {
        decision: 'allow',
        model: input.model,
        inputBytes,
        maxOutputBytes,
      }
    },
  }
}

function isAllowedAttachmentPath(path: string, allowedRoots: string[]): boolean {
  if (allowedRoots.length === 0) return false
  return allowedRoots.some(root => path === root || path.startsWith(`${root.replace(/\/+$/, '')}/`))
}
