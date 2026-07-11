import { describe, expect, test, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  createSkillActivationPlan,
  formatSkillDirective,
  prependSkillDirective,
  type LoadedSkill,
} from '@weft/skills'

const TEST_DIR = join(tmpdir(), `weft-skill-directive-test-${Date.now()}`)

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true })
})

afterEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true })
})

function makeSkill(slug: string, content = 'Instructions here'): LoadedSkill {
  const skillDir = join(TEST_DIR, '.agents', slug)
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(join(skillDir, 'SKILL.md'), content)
  return {
    slug,
    metadata: { name: slug, description: `Skill ${slug}` },
    content,
    path: skillDir,
    source: 'workspace',
  }
}

describe('Skill Prerequisite File Directive', () => {
  test('activation plan includes prerequisite files', () => {
    const skills = [makeSkill('commit'), makeSkill('review')]
    const plan = createSkillActivationPlan({
      skills,
      selectedSkillSlugs: ['commit', 'review'],
    })

    expect(plan.prerequisiteFiles).toEqual([
      `${skills[0]!.path}/SKILL.md`,
      `${skills[1]!.path}/SKILL.md`,
    ])
  })

  test('activation plan has empty prerequisite files when no skills active', () => {
    const plan = createSkillActivationPlan({ skills: [] })
    expect(plan.prerequisiteFiles).toEqual([])
  })

  test('formatSkillDirective returns undefined for empty array', () => {
    expect(formatSkillDirective([])).toBeUndefined()
  })

  test('formatSkillDirective formats file list with instruction', () => {
    const directive = formatSkillDirective([
      '/workspace/.agents/commit/SKILL.md',
    ])

    expect(directive).toContain('MUST read')
    expect(directive).toContain('/workspace/.agents/commit/SKILL.md')
    expect(directive).toContain('Do not take any other action')
  })

  test('formatSkillDirective handles multiple files', () => {
    const directive = formatSkillDirective([
      '/workspace/.agents/commit/SKILL.md',
      '/workspace/.agents/review/SKILL.md',
    ])

    expect(directive).toContain('commit/SKILL.md')
    expect(directive).toContain('review/SKILL.md')
  })

  test('prependSkillDirective prepends directive to message', () => {
    const result = prependSkillDirective('help me save changes', [
      '/workspace/.agents/commit/SKILL.md',
    ])

    expect(result).toContain('MUST read')
    expect(result).toContain('help me save changes')
    expect(result.indexOf('MUST read')).toBeLessThan(result.indexOf('help me save changes'))
  })

  test('prependSkillDirective returns original message when no files', () => {
    const message = 'just a normal message'
    const result = prependSkillDirective(message, [])
    expect(result).toBe(message)
  })
})
