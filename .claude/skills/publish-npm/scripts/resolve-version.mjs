#!/usr/bin/env node
/**
 * Resolve the next publish version for a facade package.
 *
 * Usage:
 *   node resolve-version.mjs --name @percena/weft --path publish/browser \
 *     --channel next|latest --mode auto|exact|bump [--version X] [--bump patch|minor|major]
 *
 * Prints JSON:
 *   { name, path, channel, mode, fromLocal, latestTag, nextTag, to, tag, exists }
 */
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

function arg(flag, fallback = undefined) {
  const i = process.argv.indexOf(flag)
  if (i === -1) return fallback
  return process.argv[i + 1] ?? fallback
}

function has(flag) {
  return process.argv.includes(flag)
}

/** npm view <pkg> [field] --json — field is a separate argv when present. */
function npmView(name, field) {
  const args = ['view', name]
  if (field) args.push(field)
  args.push('--json')
  const r = spawnSync('npm', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (r.status !== 0) return null
  const out = (r.stdout || '').trim()
  if (!out) return null
  try {
    return JSON.parse(out)
  } catch {
    return out.replace(/^"|"$/g, '')
  }
}

function parseSemver(v) {
  if (!v || typeof v !== 'string') return null
  const m = v.trim().match(
    /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/,
  )
  if (!m) return null
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] || null,
    raw: `${m[1]}.${m[2]}.${m[3]}${m[4] ? `-${m[4]}` : ''}`,
  }
}

function format({ major, minor, patch, prerelease }) {
  return `${major}.${minor}.${patch}${prerelease ? `-${prerelease}` : ''}`
}

function inc(parsed, bump) {
  const x = { ...parsed, prerelease: null }
  if (bump === 'major') {
    x.major += 1
    x.minor = 0
    x.patch = 0
  } else if (bump === 'minor') {
    x.minor += 1
    x.patch = 0
  } else {
    x.patch += 1
  }
  return x
}

function stableBase(parsed) {
  if (!parsed) return null
  return {
    major: parsed.major,
    minor: parsed.minor,
    patch: parsed.patch,
    prerelease: null,
  }
}

function parseNextPrerelease(parsed) {
  if (!parsed?.prerelease) return null
  const m = parsed.prerelease.match(/^next\.(\d+)$/)
  if (!m) return null
  return { base: stableBase(parsed), n: Number(m[1]) }
}

function versionExists(name, version) {
  const v = npmView(`${name}@${version}`, 'version')
  return v != null && v !== ''
}

/** For auto/bump: if target already published, walk forward until free. */
function ensureFree(name, channel, version) {
  let cur = parseSemver(version)
  if (!cur) return version
  for (let i = 0; i < 50; i++) {
    if (!versionExists(name, cur.raw)) return cur.raw
    if (channel === 'next') {
      const pr = parseNextPrerelease(cur)
      if (pr) {
        cur = {
          ...pr.base,
          prerelease: `next.${pr.n + 1}`,
          raw: format({ ...pr.base, prerelease: `next.${pr.n + 1}` }),
        }
        continue
      }
      // non-next prerelease or stable on next channel → bump next.0 then walk
      const base = stableBase(cur)
      cur = {
        ...base,
        prerelease: 'next.0',
        raw: format({ ...base, prerelease: 'next.0' }),
      }
      // if next.0 also exists loop continues
      continue
    }
    // latest: patch-inc until free
    const n = inc(cur, 'patch')
    cur = { ...n, raw: format(n) }
  }
  throw new Error(`could not find free version after ${version}`)
}

const name = arg('--name')
const pkgPath = arg('--path')
const channel = arg('--channel', 'next')
const mode = arg('--mode', 'auto')
const exact = arg('--version')
const bump = arg('--bump', 'patch')

if (!name || !pkgPath) {
  console.error(
    'usage: resolve-version.mjs --name <pkg> --path <package.json dir or file> --channel … --mode …',
  )
  process.exit(2)
}
if (!['next', 'latest'].includes(channel)) {
  console.error(`invalid channel: ${channel}`)
  process.exit(2)
}
if (!['auto', 'exact', 'bump'].includes(mode)) {
  console.error(`invalid mode: ${mode}`)
  process.exit(2)
}
if (!['patch', 'minor', 'major'].includes(bump)) {
  console.error(`invalid bump: ${bump}`)
  process.exit(2)
}

const pkgJsonPath = pkgPath.endsWith('package.json')
  ? resolve(pkgPath)
  : resolve(pkgPath, 'package.json')
const localVersion = JSON.parse(readFileSync(pkgJsonPath, 'utf8')).version
const local = parseSemver(localVersion)

const distTags = npmView(name, 'dist-tags') || {}
const latestTag = typeof distTags.latest === 'string' ? distTags.latest : null
const nextTag = typeof distTags.next === 'string' ? distTags.next : null
const latest = parseSemver(latestTag)
const next = parseSemver(nextTag)

let to
if (mode === 'exact') {
  if (!exact) {
    console.error('exact mode requires --version')
    process.exit(2)
  }
  const p = parseSemver(exact)
  if (!p) {
    console.error(`invalid semver: ${exact}`)
    process.exit(2)
  }
  to = p.raw
} else if (channel === 'next') {
  if (mode === 'bump') {
    const src = latest || stableBase(local) || parseSemver('0.0.0')
    const base = inc(src, bump)
    to = format({ ...base, prerelease: 'next.0' })
  } else {
    // auto — prefer continuing the registry `next` line when its base is still
    // on/after `latest`; if next lags behind latest (stale prerelease line),
    // retarget to latest base as `-next.0` (then ensureFree walks if needed).
    const fromNext = parseNextPrerelease(next) || parseNextPrerelease(local)
    const latestBase = stableBase(latest) || stableBase(local)
    if (fromNext && latestBase) {
      const nextBase = fromNext.base
      const behind =
        nextBase.major < latestBase.major ||
        (nextBase.major === latestBase.major && nextBase.minor < latestBase.minor) ||
        (nextBase.major === latestBase.major &&
          nextBase.minor === latestBase.minor &&
          nextBase.patch < latestBase.patch)
      if (behind) {
        to = format({ ...latestBase, prerelease: 'next.0' })
      } else {
        to = format({ ...fromNext.base, prerelease: `next.${fromNext.n + 1}` })
      }
    } else if (fromNext) {
      to = format({ ...fromNext.base, prerelease: `next.${fromNext.n + 1}` })
    } else {
      const base = stableBase(local) || stableBase(latest) || parseSemver('0.1.0')
      to = format({ ...base, prerelease: 'next.0' })
    }
  }
  to = ensureFree(name, 'next', to)
} else {
  // latest
  const src = latest || stableBase(local) || parseSemver('0.0.0')
  const useBump = mode === 'bump' || mode === 'auto' ? bump : 'patch'
  to = format(inc(src, useBump))
  if (mode !== 'exact') {
    to = ensureFree(name, 'latest', to)
  }
}

const exists = versionExists(name, to)
const tag = channel === 'next' ? 'next' : 'latest'

const result = {
  name,
  path: pkgJsonPath,
  channel,
  mode,
  bump,
  fromLocal: localVersion,
  latestTag,
  nextTag,
  to,
  tag,
  exists: Boolean(exists),
}

if (has('--check-exists') && exists) {
  console.error(JSON.stringify({ ok: false, error: 'version_exists', ...result }, null, 2))
  process.exit(3)
}

console.log(JSON.stringify(result, null, 2))
