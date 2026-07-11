export interface AutoLabelRule {
  pattern: string
  flags?: string
  valueTemplate?: string
  description?: string
}

export interface AutoLabelConfig {
  labelId: string
  rules: AutoLabelRule[]
}

export interface AutoLabelMatch {
  labelId: string
  value: string
  matchedText: string
}
