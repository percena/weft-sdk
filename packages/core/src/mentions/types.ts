export interface ParsedMentions {
  skills: string[]
  invalidSkills: string[]
  sources: string[]
  files: string[]
  folders: string[]
}

export interface MentionMatch {
  type: 'skill' | 'source' | 'file' | 'folder'
  id: string
  fullMatch: string
  startIndex: number
}
