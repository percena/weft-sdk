import { describe, expect, test } from 'vitest'

import {
  parseMentions,
  resolveSkillMentions,
  resolveSourceMentions,
  resolveFileMentions,
  stripAllMentions,
  findMentionMatches,
} from '@weft/core'

const SKILLS = ['commit', 'review', 'deploy']
const SOURCES = ['github', 'slack', 'linear']

describe('Mentions Parsing', () => {
  test('parses skill mentions', () => {
    const result = parseMentions('[skill:commit] help me save', SKILLS, SOURCES)
    expect(result.skills).toEqual(['commit'])
    expect(result.invalidSkills).toHaveLength(0)
  })

  test('detects invalid skill mentions', () => {
    const result = parseMentions('[skill:nonexistent] do something', SKILLS, SOURCES)
    expect(result.skills).toHaveLength(0)
    expect(result.invalidSkills).toEqual(['nonexistent'])
  })

  test('parses workspace-scoped skill mentions', () => {
    const result = parseMentions('[skill:My Workspace:commit]', SKILLS, SOURCES)
    expect(result.skills).toEqual(['commit'])
  })

  test('parses source mentions', () => {
    const result = parseMentions('check [source:github] for issues', SKILLS, SOURCES)
    expect(result.sources).toEqual(['github'])
  })

  test('parses file mentions', () => {
    const result = parseMentions('look at [file:src/index.ts]', SKILLS, SOURCES)
    expect(result.files).toEqual(['src/index.ts'])
  })

  test('parses folder mentions', () => {
    const result = parseMentions('check [folder:src/components]', SKILLS, SOURCES)
    expect(result.folders).toEqual(['src/components'])
  })

  test('parses multiple mention types in one message', () => {
    const text = '[skill:commit] update [file:src/app.ts] using [source:github]'
    const result = parseMentions(text, SKILLS, SOURCES)
    expect(result.skills).toEqual(['commit'])
    expect(result.files).toEqual(['src/app.ts'])
    expect(result.sources).toEqual(['github'])
  })

  test('deduplicates repeated mentions', () => {
    const text = '[skill:commit] [skill:commit] [skill:commit]'
    const result = parseMentions(text, SKILLS, SOURCES)
    expect(result.skills).toEqual(['commit'])
  })

  test('handles empty text', () => {
    const result = parseMentions('', SKILLS, SOURCES)
    expect(result.skills).toHaveLength(0)
    expect(result.sources).toHaveLength(0)
    expect(result.files).toHaveLength(0)
    expect(result.folders).toHaveLength(0)
  })

  test('handles text with no mentions', () => {
    const result = parseMentions('just regular text', SKILLS, SOURCES)
    expect(result.skills).toHaveLength(0)
  })
})

describe('Skill Mention Resolution', () => {
  test('resolves skill mention to display name', () => {
    const names = new Map([['commit', 'Git Commit']])
    const result = resolveSkillMentions('[skill:commit] help me', names)
    expect(result).toBe('[Mentioned skill: Git Commit (slug: commit)] help me')
  })

  test('falls back to slug when no display name', () => {
    const result = resolveSkillMentions('[skill:unknown] help', new Map())
    expect(result).toBe('[Mentioned skill: unknown (slug: unknown)] help')
  })

  test('resolves workspace-scoped skill', () => {
    const names = new Map([['commit', 'Git Commit']])
    const result = resolveSkillMentions('[skill:My Workspace:commit] go', names)
    expect(result).toBe('[Mentioned skill: Git Commit (slug: commit)] go')
  })
})

describe('Source Mention Resolution', () => {
  test('resolves source mention', () => {
    const result = resolveSourceMentions('check [source:github]')
    expect(result).toBe('check [Mentioned source: github]')
  })
})

describe('File Mention Resolution', () => {
  test('resolves relative file path', async () => {
    const result = await resolveFileMentions('[file:src/index.ts]', '/project')
    expect(result).toContain('[Mentioned file: index.ts (at /project/src/index.ts)]')
  })

  test('resolves absolute file path', async () => {
    const result = await resolveFileMentions('[file:/tmp/test.txt]', '/project')
    expect(result).toContain('[Mentioned file: test.txt (at /tmp/test.txt)]')
  })

  test('resolves folder mention', async () => {
    const result = await resolveFileMentions('[folder:src/components]', '/project')
    expect(result).toContain('[Mentioned folder: components (at /project/src/components)]')
  })
})

describe('Strip All Mentions', () => {
  test('strips skill mentions to slug', () => {
    const result = stripAllMentions('[skill:commit] help me')
    expect(result).toBe('commit help me')
  })

  test('strips source mentions to slug', () => {
    const result = stripAllMentions('check [source:github]')
    expect(result).toBe('check github')
  })

  test('strips file mentions to path', () => {
    const result = stripAllMentions('look at [file:src/index.ts]')
    expect(result).toBe('look at src/index.ts')
  })

  test('strips folder mentions to path', () => {
    const result = stripAllMentions('check [folder:src/components]')
    expect(result).toBe('check src/components')
  })
})

describe('Find Mention Matches', () => {
  test('finds all mentions sorted by position', () => {
    const text = '[skill:commit] and [source:github] with [file:src/index.ts]'
    const matches = findMentionMatches(text, SKILLS, SOURCES)

    expect(matches).toHaveLength(3)
    expect(matches[0]!.type).toBe('skill')
    expect(matches[1]!.type).toBe('source')
    expect(matches[2]!.type).toBe('file')

    expect(matches[0]!.startIndex).toBeLessThan(matches[1]!.startIndex)
    expect(matches[1]!.startIndex).toBeLessThan(matches[2]!.startIndex)
  })

  test('returns empty for no mentions', () => {
    const matches = findMentionMatches('plain text', SKILLS, SOURCES)
    expect(matches).toHaveLength(0)
  })
})
