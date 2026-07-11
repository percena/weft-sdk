import type { ParsedMentions, MentionMatch } from './types.ts'

export type { ParsedMentions, MentionMatch } from './types.ts'

const SKILL_PATTERN = /\[skill:([^\]]+)\]/g
const SOURCE_PATTERN = /\[source:([^\]]+)\]/g
const FILE_PATTERN = /\[file:([^\]]+)\]/g
const FOLDER_PATTERN = /\[folder:([^\]]+)\]/g

export function parseMentions(
  text: string,
  availableSkillSlugs: string[],
  availableSourceSlugs: string[],
): ParsedMentions {
  const skillSet = new Set(availableSkillSlugs)
  const sourceSet = new Set(availableSourceSlugs)

  const skills: string[] = []
  const invalidSkills: string[] = []
  const sources: string[] = []
  const files: string[] = []
  const folders: string[] = []

  for (const match of text.matchAll(SKILL_PATTERN)) {
    const slug = extractSkillSlug(match[1]!)
    if (skillSet.has(slug)) {
      if (!skills.includes(slug)) skills.push(slug)
    } else {
      if (!invalidSkills.includes(slug)) invalidSkills.push(slug)
    }
  }

  for (const match of text.matchAll(SOURCE_PATTERN)) {
    const slug = match[1]!.trim()
    if (sourceSet.has(slug) && !sources.includes(slug)) {
      sources.push(slug)
    }
  }

  for (const match of text.matchAll(FILE_PATTERN)) {
    const path = match[1]!.trim()
    if (path && !files.includes(path)) files.push(path)
  }

  for (const match of text.matchAll(FOLDER_PATTERN)) {
    const path = match[1]!.trim()
    if (path && !folders.includes(path)) folders.push(path)
  }

  return { skills, invalidSkills, sources, files, folders }
}

export function resolveSkillMentions(
  text: string,
  skillNames: Map<string, string>,
): string {
  return text.replace(SKILL_PATTERN, (_full, raw: string) => {
    const slug = extractSkillSlug(raw)
    const displayName = skillNames.get(slug) ?? slug
    return `[Mentioned skill: ${displayName} (slug: ${slug})]`
  })
}

export function resolveSourceMentions(text: string): string {
  return text.replace(SOURCE_PATTERN, (_, slug: string) => {
    return `[Mentioned source: ${slug.trim()}]`
  })
}

export async function resolvePathMentions(text: string, workingDirectory?: string): Promise<string> {
  const { basename } = await import('node:path')
  const cwd = workingDirectory ?? process.cwd()

  // Pre-resolve all file/folder paths
  const fileMatches = [...text.matchAll(FILE_PATTERN)]
  const folderMatches = [...text.matchAll(FOLDER_PATTERN)]

  const fileReplacements = new Map<string, string>()
  for (const match of fileMatches) {
    const rawPath = match[1]!.trim()
    const absPath = await resolvePath(rawPath, cwd)
    const name = basename(absPath)
    fileReplacements.set(match[0], `[Mentioned file: ${name} (at ${absPath})]`)
  }

  const folderReplacements = new Map<string, string>()
  for (const match of folderMatches) {
    const rawPath = match[1]!.trim()
    const absPath = await resolvePath(rawPath, cwd)
    const name = basename(absPath)
    folderReplacements.set(match[0], `[Mentioned folder: ${name} (at ${absPath})]`)
  }

  let result = text
  for (const [original, replacement] of fileReplacements) {
    result = result.replace(original, replacement)
  }
  for (const [original, replacement] of folderReplacements) {
    result = result.replace(original, replacement)
  }

  return result
}

export function resolveFileMentions(text: string, workingDirectory?: string): Promise<string> {
  return resolvePathMentions(text, workingDirectory)
}

export function stripAllMentions(text: string): string {
  let result = text
  result = result.replace(SKILL_PATTERN, (_, raw: string) => extractSkillSlug(raw))
  result = result.replace(SOURCE_PATTERN, (_, slug: string) => slug.trim())
  result = result.replace(FILE_PATTERN, (_, p: string) => p.trim())
  result = result.replace(FOLDER_PATTERN, (_, p: string) => p.trim())
  return result.replace(/\s{2,}/g, ' ').trim()
}

export function findMentionMatches(
  text: string,
  _availableSkillSlugs: string[],
  _availableSourceSlugs: string[],
): MentionMatch[] {
  const matches: MentionMatch[] = []

  for (const match of text.matchAll(SKILL_PATTERN)) {
    matches.push({
      type: 'skill',
      id: extractSkillSlug(match[1]!),
      fullMatch: match[0],
      startIndex: match.index!,
    })
  }

  for (const match of text.matchAll(SOURCE_PATTERN)) {
    matches.push({
      type: 'source',
      id: match[1]!.trim(),
      fullMatch: match[0],
      startIndex: match.index!,
    })
  }

  for (const match of text.matchAll(FILE_PATTERN)) {
    matches.push({
      type: 'file',
      id: match[1]!.trim(),
      fullMatch: match[0],
      startIndex: match.index!,
    })
  }

  for (const match of text.matchAll(FOLDER_PATTERN)) {
    matches.push({
      type: 'folder',
      id: match[1]!.trim(),
      fullMatch: match[0],
      startIndex: match.index!,
    })
  }

  return matches.sort((a, b) => a.startIndex - b.startIndex)
}

function extractSkillSlug(raw: string): string {
  const parts = raw.trim().split(':')
  return parts[parts.length - 1]!.trim()
}

async function resolvePath(path: string, cwd: string): Promise<string> {
  const { resolve } = await import('node:path')
  if (path.startsWith('~')) {
    const { homedir } = await import('node:os')
    return resolve(homedir(), path.slice(2))
  }
  if (path.startsWith('/')) return path
  return resolve(cwd, path)
}
