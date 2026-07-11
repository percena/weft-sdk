import type { LoadedSkill } from './types.ts'
import { globMatches } from '@weft/core'

export type SkillActivationReason = 'prompt-mention' | 'file-glob' | 'host-selection'

export interface SkillActivation {
  skill: LoadedSkill
  reason: SkillActivationReason
}

export interface CreateSkillActivationPlanOptions {
  skills: LoadedSkill[]
  prompt?: string
  filePaths?: string[]
  selectedSkillSlugs?: string[]
  enabledSourceSlugs?: string[]
  prerequisiteFileExists?: (path: string) => boolean
}

export interface SkillPolicyExtension {
  toolName: string
  scope: {
    type: 'skill'
    skillSlug: string
  }
}

export interface SkillActivationPlan {
  activeSkillSlugs: string[]
  activations: SkillActivation[]
  requiredSourceSlugs: string[]
  missingRequiredSourceSlugs: string[]
  policyExtensions: SkillPolicyExtension[]
  providerInstructions: string
  prerequisiteFiles: string[]
}

export function createSkillActivationPlan(
  options: CreateSkillActivationPlanOptions,
): SkillActivationPlan {
  const enabledSources = new Set(options.enabledSourceSlugs ?? [])
  const selected = new Set(options.selectedSkillSlugs ?? [])
  const promptMentions = parseSkillMentions(options.prompt ?? '')
  const filePaths = options.filePaths ?? []
  const activations: SkillActivation[] = []
  const seen = new Set<string>()

  for (const skill of options.skills) {
    const reason = activationReason(skill, {
      selected,
      promptMentions,
      filePaths,
    })
    if (!reason || seen.has(skill.slug)) continue

    seen.add(skill.slug)
    activations.push({ skill, reason })
  }

  const requiredSourceSlugs = unique(activations.flatMap(
    activation => activation.skill.metadata.requiredSources ?? [],
  ))
  const missingRequiredSourceSlugs = requiredSourceSlugs.filter(source => !enabledSources.has(source))
  const policyExtensions = activations.flatMap(({ skill }) => (
    skill.metadata.alwaysAllow ?? []
  ).map<SkillPolicyExtension>(toolName => ({
    toolName,
    scope: { type: 'skill', skillSlug: skill.slug },
  })))

  const prerequisiteFiles = activations
    .map(({ skill }) => `${skill.path}/SKILL.md`)
    .filter(path => options.prerequisiteFileExists?.(path) ?? true)

  return {
    activeSkillSlugs: activations.map(activation => activation.skill.slug),
    activations,
    requiredSourceSlugs,
    missingRequiredSourceSlugs,
    policyExtensions,
    providerInstructions: buildProviderInstructions(activations),
    prerequisiteFiles,
  }
}

function activationReason(
  skill: LoadedSkill,
  context: {
    selected: Set<string>
    promptMentions: Set<string>
    filePaths: string[]
  },
): SkillActivationReason | undefined {
  if (context.promptMentions.has(skill.slug)) return 'prompt-mention'
  if (context.selected.has(skill.slug)) return 'host-selection'
  if (matchesAnyGlob(skill.metadata.globs ?? [], context.filePaths)) return 'file-glob'
  return undefined
}

function parseSkillMentions(prompt: string): Set<string> {
  const mentions = new Set<string>()
  for (const match of prompt.matchAll(/@([A-Za-z0-9_-]+)/g)) {
    mentions.add(match[1])
  }
  return mentions
}

function matchesAnyGlob(globs: string[], filePaths: string[]): boolean {
  return globs.some(glob => filePaths.some(filePath => globMatches(glob, filePath)))
}

function buildProviderInstructions(activations: SkillActivation[]): string {
  return activations
    .map(({ skill }) => `# ${skill.metadata.name}\n\n${skill.content}`)
    .join('\n\n')
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}
