/**
 * Tests for the safeMatter wrapper (gray-matter JS engine eval hardening).
 *
 * gray-matter's default `js`/`javascript` engine executes frontmatter with
 * eval(). safeMatter must never execute code — code-language frontmatter
 * throws and is treated like any other invalid frontmatter by callers.
 */

import { describe, it, expect } from 'vitest';
import { safeMatter } from './frontmatter.ts';
import { validateSkillDefinitionContent } from '../validation.ts';

declare global {
  var __weftFrontmatterPwned: boolean | undefined;
}

describe('safeMatter', () => {
  it('parses YAML frontmatter unchanged', () => {
    const parsed = safeMatter('---\nname: Test\ndescription: Desc\n---\nBody\n');
    expect(parsed.data).toEqual({ name: 'Test', description: 'Desc' });
    expect(parsed.content.trim()).toBe('Body');
  });

  it('does not execute js frontmatter', () => {
    globalThis.__weftFrontmatterPwned = false;
    const payload = '---js\nmodule.exports = (globalThis.__weftFrontmatterPwned = true) && {}\n---\nBody\n';
    expect(() => safeMatter(payload)).toThrow(/frontmatter engine disabled/);
    expect(globalThis.__weftFrontmatterPwned).toBe(false);
  });

  it('blocks all code engine aliases', () => {
    for (const lang of ['js', 'javascript', 'coffee', 'coffeescript', 'cson']) {
      expect(() => safeMatter(`---${lang}\nfoo\n---\nBody\n`)).toThrow(/frontmatter engine disabled/);
    }
  });
});

describe('validateSkillDefinitionContent with js frontmatter', () => {
  it('reports invalid frontmatter instead of executing code', () => {
    globalThis.__weftFrontmatterPwned = false;
    const result = validateSkillDefinitionContent(
      '---js\nmodule.exports = (globalThis.__weftFrontmatterPwned = true) && {}\n---\nBody\n'
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.message).toMatch(/Invalid skill frontmatter/);
    expect(globalThis.__weftFrontmatterPwned).toBe(false);
  });
});
