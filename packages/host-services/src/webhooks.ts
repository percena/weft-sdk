export interface WebhookTemplateExpansionInput {
  template: string
  variables?: Record<string, string | undefined>
  secrets?: Record<string, string | undefined>
}

export interface WebhookTemplateVariableReceipt {
  name: string
  found: boolean
  source?: 'variable' | 'secret'
  redacted: boolean
}

export interface WebhookTemplateExpansionReceipt {
  expanded: string
  redactedPreview: string
  missingVariables: string[]
  variables: WebhookTemplateVariableReceipt[]
}

export function expandWebhookTemplate(input: WebhookTemplateExpansionInput): WebhookTemplateExpansionReceipt {
  const variables = input.variables ?? {}
  const secrets = input.secrets ?? {}
  const receipts = new Map<string, WebhookTemplateVariableReceipt>()
  const missing = new Set<string>()

  const expanded = input.template.replace(/\$\{([A-Z0-9_]+)\}|\$([A-Z0-9_]+)/g, (match, braced: string | undefined, bare: string | undefined) => {
    const name = braced ?? bare
    if (!name) return match

    if (Object.hasOwn(secrets, name) && secrets[name] !== undefined) {
      receipts.set(name, { name, found: true, source: 'secret', redacted: true })
      return String(secrets[name])
    }

    if (Object.hasOwn(variables, name) && variables[name] !== undefined) {
      receipts.set(name, { name, found: true, source: 'variable', redacted: false })
      return String(variables[name])
    }

    missing.add(name)
    receipts.set(name, { name, found: false, redacted: false })
    return match
  })

  let redactedPreview = expanded
  for (const [name, value] of Object.entries(secrets)) {
    if (!value) continue
    redactedPreview = redactedPreview.split(value).join('[REDACTED]')
    if (!receipts.has(name)) {
      receipts.set(name, { name, found: false, source: 'secret', redacted: true })
    }
  }

  return {
    expanded,
    redactedPreview,
    missingVariables: [...missing].sort(),
    variables: [...receipts.values()].sort((left, right) => left.name.localeCompare(right.name)),
  }
}
