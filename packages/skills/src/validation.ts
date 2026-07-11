import type matter from 'gray-matter';
import { safeMatter } from './utils/frontmatter.ts';

export interface SkillValidationIssue {
  file: string;
  path: string;
  message: string;
  severity: 'error' | 'warning' | 'info';
  suggestion?: string;
}

export interface SkillValidationResult {
  valid: boolean;
  errors: SkillValidationIssue[];
  warnings: SkillValidationIssue[];
}

export function validateSkillDefinitionContent(
  content: string,
  file = 'SKILL.md',
): SkillValidationResult {
  const errors: SkillValidationIssue[] = [];
  const warnings: SkillValidationIssue[] = [];

  let parsed: matter.GrayMatterFile<string>;
  try {
    parsed = safeMatter(content);
  } catch (error) {
    errors.push(issue(
      file,
      'frontmatter',
      `Invalid skill frontmatter: ${error instanceof Error ? error.message : 'Unknown error'}`,
      'error',
    ));
    return result(errors, warnings);
  }

  const data = parsed.data && typeof parsed.data === 'object'
    ? parsed.data as Record<string, unknown>
    : {};

  if (!isNonEmptyString(data.name)) {
    errors.push(issue(file, 'frontmatter.name', 'Skill metadata requires name', 'error'));
  }
  if (!isNonEmptyString(data.description)) {
    errors.push(issue(file, 'frontmatter.description', 'Skill metadata requires description', 'error'));
  }

  validateStringArray(data.globs, 'frontmatter.globs', file, errors);
  validateStringArray(data.alwaysAllow, 'frontmatter.alwaysAllow', file, errors);
  validateRequiredSources(data.requiredSources, file, errors);

  if (!data.globs && !data.requiredSources) {
    warnings.push(issue(
      file,
      'frontmatter',
      'Skill has no activation metadata',
      'warning',
      'Add globs, requiredSources, or select the skill explicitly from the host UI.',
    ));
  }

  if (!parsed.content.trim()) {
    warnings.push(issue(
      file,
      'content',
      'Skill body is empty',
      'warning',
      'Add provider instructions to make the skill useful when activated.',
    ));
  }

  return result(errors, warnings);
}

function validateRequiredSources(
  value: unknown,
  file: string,
  errors: SkillValidationIssue[],
): void {
  if (value === undefined) return;
  if (typeof value === 'string') return;
  validateStringArray(value, 'frontmatter.requiredSources', file, errors);
}

function validateStringArray(
  value: unknown,
  path: string,
  file: string,
  errors: SkillValidationIssue[],
): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    errors.push(issue(file, path, `${leafName(path)} must be an array of strings`, 'error'));
    return;
  }
  value.forEach((entry, index) => {
    if (typeof entry !== 'string') {
      errors.push(issue(file, `${path}[${index}]`, `${leafName(path)} entries must be strings`, 'error'));
    }
  });
}

function issue(
  file: string,
  path: string,
  message: string,
  severity: SkillValidationIssue['severity'],
  suggestion?: string,
): SkillValidationIssue {
  return {
    file,
    path,
    message,
    severity,
    ...(suggestion ? { suggestion } : {}),
  };
}

function result(errors: SkillValidationIssue[], warnings: SkillValidationIssue[]): SkillValidationResult {
  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function leafName(path: string): string {
  return path.split('.').at(-1) ?? path;
}
