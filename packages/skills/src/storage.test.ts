/**
 * Tests for skill storage slug validation (path traversal hardening).
 *
 * Every storage function that accepts a slug must reject traversal payloads
 * ("../x", "a/b", "..", absolute paths, empty) before touching the filesystem.
 */

import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createSkill,
  deleteSkill,
  getSkillIconPath,
  loadSkill,
  loadSkillBySlug,
  skillExists,
  updateSkill,
} from './storage.ts';
import { isValidSlug } from './utils/slug.ts';

const TRAVERSAL_SLUGS = ['../x', 'a/b', '..', '/etc/passwd', '', '.', 'a\\b', '../../victim'];

let workspaceRoot: string;

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'weft-skills-test-'));
});

afterEach(() => {
  rmSync(workspaceRoot, { recursive: true, force: true });
});

function writeSkillFixture(slug: string): void {
  const skillDir = join(workspaceRoot, 'skills', slug);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, 'SKILL.md'),
    '---\nname: Test Skill\ndescription: A test skill\n---\nBody\n',
    'utf-8'
  );
}

describe('slug validation', () => {
  it('accepts normal slugs', () => {
    for (const slug of ['my-skill', 'skill2', 'a', 'my_skill', '0-start', 'long-slug-with-many-parts']) {
      expect(isValidSlug(slug), slug).toBe(true);
    }
  });

  it('rejects traversal and malformed slugs', () => {
    for (const slug of [...TRAVERSAL_SLUGS, '-leading-hyphen', 'UPPER', 'has space', 'dot.dot']) {
      expect(isValidSlug(slug), slug).toBe(false);
    }
  });
});

describe('storage functions reject traversal slugs', () => {
  it('createSkill throws', () => {
    for (const slug of TRAVERSAL_SLUGS) {
      expect(() =>
        createSkill(workspaceRoot, { slug, name: 'x', description: 'y', content: 'z' })
      ).toThrow(/Invalid skill slug/);
    }
  });

  it('deleteSkill throws and does not delete outside the skills dir', () => {
    // A sibling directory that "../x"-style slugs would resolve to
    const victim = join(workspaceRoot, 'victim');
    mkdirSync(victim, { recursive: true });

    for (const slug of TRAVERSAL_SLUGS) {
      expect(() => deleteSkill(workspaceRoot, slug)).toThrow(/Invalid skill slug/);
    }
    expect(existsSync(victim)).toBe(true);
  });

  it('getSkillIconPath throws', () => {
    for (const slug of TRAVERSAL_SLUGS) {
      expect(() => getSkillIconPath(workspaceRoot, slug)).toThrow(/Invalid skill slug/);
    }
  });

  it('loadSkill / loadSkillBySlug / skillExists / updateSkill throw', () => {
    for (const slug of TRAVERSAL_SLUGS) {
      expect(() => loadSkill(workspaceRoot, slug)).toThrow(/Invalid skill slug/);
      expect(() => loadSkillBySlug(workspaceRoot, slug)).toThrow(/Invalid skill slug/);
      expect(() => skillExists(workspaceRoot, slug)).toThrow(/Invalid skill slug/);
      expect(() => updateSkill(workspaceRoot, slug, { name: 'x' })).toThrow(/Invalid skill slug/);
    }
  });
});

describe('storage functions accept normal slugs', () => {
  it('createSkill / loadSkill / skillExists / deleteSkill round-trip', () => {
    const created = createSkill(workspaceRoot, {
      slug: 'my-skill_2',
      name: 'My Skill',
      description: 'desc',
      content: 'Body',
    });
    expect(created.slug).toBe('my-skill_2');
    expect(skillExists(workspaceRoot, 'my-skill_2')).toBe(true);
    expect(loadSkill(workspaceRoot, 'my-skill_2')?.metadata.name).toBe('My Skill');
    expect(deleteSkill(workspaceRoot, 'my-skill_2')).toBe(true);
    expect(skillExists(workspaceRoot, 'my-skill_2')).toBe(false);
  });

  it('loadSkill returns null for missing (but valid) slugs', () => {
    expect(loadSkill(workspaceRoot, 'does-not-exist')).toBeNull();
  });

  it('loadSkill parses an on-disk fixture', () => {
    writeSkillFixture('fixture-skill');
    const skill = loadSkill(workspaceRoot, 'fixture-skill');
    expect(skill?.metadata.name).toBe('Test Skill');
  });
});
