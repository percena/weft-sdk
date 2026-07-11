/**
 * @weft/core
 *
 * Core types and utilities for Weft.
 *
 * NOTE: This package currently only exports types and utilities.
 * Storage, credentials, agent, auth, mcp, and prompts are still
 * imported directly from src/ in the consuming apps.
 */

// Re-export all types
export * from './types/index.ts';

// Re-export utilities
export * from './utils/index.ts';

// Re-export protocol DTOs and RPC definitions
export * from './protocol/index.ts';

// Mentions parsing
export {
  parseMentions,
  resolveSkillMentions,
  resolveSourceMentions,
  resolvePathMentions,
  resolveFileMentions,
  stripAllMentions,
  findMentionMatches,
} from './mentions/index.ts';
export type { ParsedMentions, MentionMatch } from './mentions/index.ts';
