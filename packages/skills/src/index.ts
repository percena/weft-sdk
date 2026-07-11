/**
 * Skills Module
 *
 * Workspace skills are specialized instructions that extend Claude's capabilities.
 */

export * from './types.ts';
export {
  createSkillActivationPlan,
  type CreateSkillActivationPlanOptions,
  type SkillActivation,
  type SkillActivationPlan,
  type SkillActivationReason,
  type SkillPolicyExtension,
} from './activation.ts';
export {
  validateSkillDefinitionContent,
  type SkillValidationIssue,
  type SkillValidationResult,
} from './validation.ts';
export {
  GLOBAL_AGENT_SKILLS_DIR,
  PROJECT_AGENT_SKILLS_DIR,
  loadSkill,
  loadAllSkills,
  invalidateSkillsCache,
  loadSkillBySlug,
  getSkillIconPath,
  createSkill,
  updateSkill,
  deleteSkill,
  skillExists,
  listSkillSlugs,
  skillNeedsIconDownload,
  downloadSkillIcon,
  type CreateSkillInput,
  type UpdateSkillInput,
} from './storage.ts';
export {
  formatSkillDirective,
  prependSkillDirective,
} from './directives.ts';
