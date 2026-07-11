/**
 * Tests for buildUrl SSRF hardening.
 *
 * The endpoint path comes from the LLM, so it must never be able to move the
 * request off the configured base URL's origin.
 */

import { describe, it, expect } from 'vitest';
import { buildUrl } from './api-tools.ts';

const noAuth = undefined;

describe('buildUrl', () => {
  it('joins path onto the base URL', () => {
    expect(buildUrl('https://api.example.com', '/users', 'GET', undefined, noAuth, '')).toBe(
      'https://api.example.com/users'
    );
    // Missing leading slash is normalized
    expect(buildUrl('https://api.example.com', 'users', 'GET', undefined, noAuth, '')).toBe(
      'https://api.example.com/users'
    );
  });

  it('preserves base URL path prefixes', () => {
    expect(buildUrl('https://api.example.com/v2/', '/users', 'GET', undefined, noAuth, '')).toBe(
      'https://api.example.com/v2/users'
    );
  });

  it('appends GET params and query auth', () => {
    const url = buildUrl(
      'https://api.example.com',
      '/search',
      'GET',
      { q: 'weft' },
      { type: 'query', queryParam: 'key' },
      'secret'
    );
    expect(url).toBe('https://api.example.com/search?key=secret&q=weft');
  });

  it('rejects protocol-relative paths (//evil.com/x)', () => {
    expect(() =>
      buildUrl('https://api.example.com', '//evil.com/x', 'GET', undefined, noAuth, '')
    ).toThrow(/outside the source base URL origin/);
  });

  it('rejects absolute-URL paths that rewrite the host', () => {
    expect(() =>
      buildUrl('https://api.example.com', 'https://evil.com/x', 'GET', undefined, noAuth, '')
    ).toThrow(/outside the source base URL origin/);
  });

  it('rejects scheme downgrades to the same host', () => {
    expect(() =>
      buildUrl('https://api.example.com', 'http://api.example.com/x', 'GET', undefined, noAuth, '')
    ).toThrow(/outside the source base URL origin/);
  });
});
