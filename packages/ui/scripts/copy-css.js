import { cpSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const src = resolve(pkgRoot, 'src/styles/index.css')
const dest = resolve(pkgRoot, 'dist/styles')

if (!existsSync(src)) {
  console.error('✗ Source CSS not found:', src)
  process.exit(1)
}

mkdirSync(dest, { recursive: true })
cpSync(src, resolve(dest, 'index.css'))
console.log('✓ Copied styles/index.css → dist/styles/')
