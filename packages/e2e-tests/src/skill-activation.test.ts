import { describe, expect, test } from 'vitest'

import {
  createSkillActivationPlan,
  type LoadedSkill,
} from '@weft/skills'

const reviewSkill: LoadedSkill = {
  slug: 'review',
  source: 'workspace',
  path: '/workspace/.agents/review',
  content: 'Review changed code and report concrete findings first.',
  metadata: {
    name: 'Review',
    description: 'Code review helper',
    globs: ['src/**/*.ts'],
    requiredSources: ['github'],
    alwaysAllow: ['Bash'],
  },
}

const docsSkill: LoadedSkill = {
  slug: 'docs',
  source: 'project',
  path: '/workspace/.agents/docs',
  content: 'Keep architecture docs implementation-ready.',
  metadata: {
    name: 'Docs',
    description: 'Documentation helper',
    globs: ['docs/**'],
  },
}

describe('Skills — provider-neutral activation plan', () => {
  test('activates skills from prompt mentions and file globs without duplicates', () => {
    const plan = createSkillActivationPlan({
      skills: [reviewSkill, docsSkill],
      prompt: 'Use @review on these changes',
      filePaths: ['src/index.ts', 'docs/ARCHITECTURE.md'],
      enabledSourceSlugs: ['github'],
    })

    expect(plan.activeSkillSlugs).toEqual(['review', 'docs'])
    expect(plan.activations.map(activation => activation.reason)).toEqual([
      'prompt-mention',
      'file-glob',
    ])
    expect(plan.providerInstructions).toContain('Review changed code')
    expect(plan.providerInstructions).toContain('Keep architecture docs')
  })

  test('surfaces required source gaps and scoped always-allow policy extensions', () => {
    const plan = createSkillActivationPlan({
      skills: [reviewSkill],
      prompt: '@review this PR',
      filePaths: [],
      enabledSourceSlugs: [],
    })

    expect(plan.requiredSourceSlugs).toEqual(['github'])
    expect(plan.missingRequiredSourceSlugs).toEqual(['github'])
    expect(plan.policyExtensions).toEqual([
      {
        toolName: 'Bash',
        scope: { type: 'skill', skillSlug: 'review' },
      },
    ])
  })
})
