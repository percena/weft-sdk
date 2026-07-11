/**
 * Tests for source storage slug validation (path traversal hardening).
 *
 * getSourcePath (and everything built on it, e.g. deleteSource) must reject
 * traversal payloads ("../x", "a/b", "..", absolute paths, empty) before
 * touching the filesystem.
 */

import { mkdtempSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getSourcePath, deleteSource, loadSourceConfig, sourceExists } from './storage.ts';
import { validateSourceConfig } from './config/validators.ts';
import { isValidSlug } from './utils/slug.ts';

const TRAVERSAL_SLUGS = ['../x', 'a/b', '..', '/etc/passwd', '', '.', 'a\\b', '../../victim'];

let workspaceRoot: string;

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'weft-sources-test-'));
});

afterEach(() => {
  rmSync(workspaceRoot, { recursive: true, force: true });
});

describe('slug validation', () => {
  it('accepts normal slugs', () => {
    for (const slug of ['linear', 'github-2', 'my_source', '0source', 'a']) {
      expect(isValidSlug(slug), slug).toBe(true);
    }
  });

  it('rejects traversal and malformed slugs', () => {
    for (const slug of [...TRAVERSAL_SLUGS, '-lead', 'UPPER', 'has space']) {
      expect(isValidSlug(slug), slug).toBe(false);
    }
  });
});

describe('storage functions reject traversal slugs', () => {
  it('getSourcePath throws', () => {
    for (const slug of TRAVERSAL_SLUGS) {
      expect(() => getSourcePath(workspaceRoot, slug)).toThrow(/Invalid source slug/);
    }
  });

  it('deleteSource throws and does not delete outside the sources dir', () => {
    // A sibling directory that "../x"-style slugs would resolve to
    const victim = join(workspaceRoot, 'victim');
    mkdirSync(victim, { recursive: true });

    for (const slug of TRAVERSAL_SLUGS) {
      expect(() => deleteSource(workspaceRoot, slug)).toThrow(/Invalid source slug/);
    }
    expect(existsSync(victim)).toBe(true);
  });

  it('loadSourceConfig / sourceExists throw', () => {
    for (const slug of TRAVERSAL_SLUGS) {
      expect(() => loadSourceConfig(workspaceRoot, slug)).toThrow(/Invalid source slug/);
      expect(() => sourceExists(workspaceRoot, slug)).toThrow(/Invalid source slug/);
    }
  });

  it('getSourcePath accepts normal slugs', () => {
    expect(getSourcePath(workspaceRoot, 'linear')).toBe(join(workspaceRoot, 'sources', 'linear'));
    expect(sourceExists(workspaceRoot, 'linear')).toBe(false);
  });
});

describe('validateSourceConfig slug format', () => {
  function makeConfig(slug: string) {
    return {
      id: 'test_12345678',
      name: 'Test',
      slug,
      provider: 'test',
      enabled: true,
      type: 'local',
      local: { path: '/tmp/test' },
    };
  }

  it('accepts valid slugs', () => {
    const result = validateSourceConfig(makeConfig('my-source_2'));
    expect(result.valid).toBe(true);
  });

  it('rejects traversal slugs with an error', () => {
    for (const slug of ['../x', 'a/b', '..', '/etc/passwd']) {
      const result = validateSourceConfig(makeConfig(slug));
      expect(result.valid, slug).toBe(false);
      expect(result.errors.some((e) => e.path === 'slug' && e.message.includes('Invalid source slug'))).toBe(true);
    }
  });
});
