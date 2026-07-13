#!/usr/bin/env node
/**
 * bundle-dts.mjs
 *
 * Post-processes tsup-generated .d.ts files to inline all @weft/* type
 * declarations. ESM-only since the 0.5.0-next track: tsup emits .d.ts only
 * (no .d.cts), so the matcher below is a no-op on CJS but kept permissive.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(__dirname, '..', 'dist');
const PKGS = path.join(__dirname, '..', '..', '..', 'packages');

const PKG_DIR = {
  '@weft/core':         'core',
  '@weft/timeline':     'timeline',
  '@weft/runtime-core': 'runtime-core',
  '@weft/policy':       'policy',
  '@weft/ui':           'ui',
  '@weft/chat':         'chat',
  '@weft/adapter':      'adapter',
  '@weft/automations':  'automations',
  '@weft/host-services':'host-services',
  '@weft/providers':    'providers',
  '@weft/cli-runtime':  'cli-runtime',
  '@weft/skills':       'skills',
  '@weft/sources':      'sources',
};

function findDts(dir) {
  if (!fs.existsSync(dir)) return [];
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findDts(full));
    } else if (/\.d\.ts$/.test(entry.name)) {
      results.push(full);
    }
  }
  return results;
}

function readPkgAllDts(pkgName) {
  // Handle subpath imports like @weft/providers/flitro
  const parts = pkgName.replace('@weft/', '').split('/');
  const dir = PKG_DIR[`@weft/${parts[0]}`];
  if (!dir) return null;
  const distDir = path.join(PKGS, dir, 'dist');
  const subpath = parts.slice(1).join('/');
  const entry = path.join(distDir, `${subpath || 'index'}.d.ts`);
  const files = subpath && fs.existsSync(entry) ? [entry] : findDts(distDir);
  if (files.length === 0) return null;

  const dtsBlocks = [];
  for (const f of files) {
    const content = fs.readFileSync(f, 'utf-8');
    const rel = path.relative(distDir, f);
    dtsBlocks.push(`// -- ${pkgName}/${rel} --\n${content}`);
  }
  return dtsBlocks.join('\n');
}

function findWeftRefs(text) {
  const refs = new Set();
  const re = /from\s+['"](@weft\/[^'"]+)['"]/g;
  let m;
  while ((m = re.exec(text))) refs.add(m[1]);
  return refs;
}

function collectDeps(entryContent) {
  const visited = new Set();
  const order = [];

  function visit(pkgName) {
    if (visited.has(pkgName)) return;
    visited.add(pkgName);
    const content = readPkgAllDts(pkgName);
    if (!content) return;
    for (const dep of findWeftRefs(content)) visit(dep);
    order.push({ name: pkgName, content });
  }

  for (const ref of findWeftRefs(entryContent)) visit(ref);
  return order;
}

function stripInternalImports(content) {
  return content
    .split('\n')
    .filter(line => {
      if (/^\s*import\s+.*from\s+['"]@weft\//.test(line)) return false;
      if (/^\s*export\s+\*\s+from\s+['"]@weft\//.test(line)) return false;
      if (/^\s*export\s+\{[^}]*\}\s+from\s+['"]@weft\//.test(line)) return false;
      if (/^\s*import\s+.*from\s+['"]\.\//.test(line)) return false;
      if (/^\s*export\s+\{[^}]*\}\s+from\s+['"]\.\//.test(line)) return false;
      if (/^\s*export\s+\*\s+from\s+['"]\.\//.test(line)) return false;
      return true;
    })
    .join('\n');
}

function processEntry(entryContent) {
  const deps = collectDeps(entryContent);

  const vendorBlocks = [];
  for (const { name, content } of deps) {
    const cleaned = stripInternalImports(content).trim();
    if (cleaned) {
      vendorBlocks.push(`// ── inlined from ${name} ──\n${cleaned}`);
    }
  }

  const cleanedEntry = entryContent
    .split('\n')
    .map(line => {
      if (/^\s*export\s+\*\s+from\s+['"]@weft\//.test(line)) return null;
      const namedExport = line.match(
        /^(\s*export\s+\{[^}]*\})\s+from\s+['"]@weft\/[^'"]+['"](.*)$/
      );
      if (namedExport) return `${namedExport[1]}${namedExport[2]}`;
      return line;
    })
    .filter(l => l !== null)
    .join('\n');

  return `${[cleanedEntry.trim(), ...vendorBlocks].join('\n\n')}\n`;
}

const dtsFiles = fs.readdirSync(DIST).filter(f => /\.d\.[cm]?ts$/.test(f));
let changed = 0;

for (const file of dtsFiles) {
  const filePath = path.join(DIST, file);
  const original = fs.readFileSync(filePath, 'utf-8');

  if (!original.includes('@weft/')) continue;

  const bundled = processEntry(original);
  fs.writeFileSync(filePath, bundled);
  changed++;
  console.log(`  ✓ ${file} (${(bundled.length / 1024).toFixed(1)} KB)`);
}

console.log(`\nBundled ${changed} DTS files.`);
