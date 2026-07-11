import { createHash, pbkdf2Sync, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto'
import { readFileSync, renameSync, unlinkSync, existsSync, mkdirSync, chmodSync, openSync, writeSync, closeSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'

import type { CredentialId, StoredCredential } from './types.ts'
import { getMachineId } from './machine-id.ts'

const MAGIC = Buffer.from('WEFT01\0\0')
const HEADER_SIZE = 64
const SALT_SIZE = 32
const IV_SIZE = 12
const TAG_SIZE = 16
const PBKDF2_ITERATIONS = 100_000
const KEY_LENGTH = 32
const DEFAULT_PATH = join(homedir(), '.weft', 'credentials.enc')

type CredentialStore = Record<string, StoredCredential>

export class EncryptedCredentialBackend {
  private filePath: string
  private cache: CredentialStore | null = null

  constructor(filePath?: string) {
    this.filePath = filePath ?? DEFAULT_PATH
  }

  async get(id: CredentialId): Promise<StoredCredential | null> {
    const store = this.load()
    return store[credentialKey(id)] ?? null
  }

  async set(id: CredentialId, credential: StoredCredential): Promise<void> {
    const store = this.load()
    store[credentialKey(id)] = credential
    this.save(store)
  }

  async delete(id: CredentialId): Promise<boolean> {
    const store = this.load()
    const key = credentialKey(id)
    if (!(key in store)) return false
    delete store[key]
    this.save(store)
    return true
  }

  async list(filter?: Partial<CredentialId>): Promise<CredentialId[]> {
    const store = this.load()
    return Object.keys(store)
      .map(parseCredentialKey)
      .filter((id): id is CredentialId => {
        if (!id) return false
        if (filter?.type && id.type !== filter.type) return false
        if (filter?.workspaceId && id.workspaceId !== filter.workspaceId) return false
        if (filter?.sourceId && id.sourceId !== filter.sourceId) return false
        return true
      })
  }

  private load(): CredentialStore {
    if (this.cache) return this.cache

    if (!existsSync(this.filePath)) {
      this.cache = {}
      return this.cache
    }

    const buf = readFileSync(this.filePath)

    if (buf.length < HEADER_SIZE + IV_SIZE + TAG_SIZE) {
      this.cache = {}
      return this.cache
    }

    const magic = buf.subarray(0, MAGIC.length)
    if (!magic.equals(MAGIC)) {
      throw new Error('Corrupt credential file: invalid magic bytes')
    }

    const salt = buf.subarray(12, 12 + SALT_SIZE)
    const payload = buf.subarray(HEADER_SIZE)

    const iv = payload.subarray(0, IV_SIZE)
    const tag = payload.subarray(IV_SIZE, IV_SIZE + TAG_SIZE)
    const ciphertext = payload.subarray(IV_SIZE + TAG_SIZE)

    const key = deriveKey(salt)
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(tag)

    let plaintext: Buffer
    try {
      plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
    } catch {
      throw new Error('Failed to decrypt credential file — machine identity may have changed')
    }

    try {
      this.cache = JSON.parse(plaintext.toString('utf-8')) as CredentialStore
    } catch {
      throw new Error('Corrupt credential file: invalid JSON payload')
    }

    return this.cache
  }

  private save(store: CredentialStore): void {
    this.cache = store

    const dir = dirname(this.filePath)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
    // Re-assert directory permissions: mkdirSync's mode only applies when the
    // directory is created, so a pre-existing ~/.weft/ with a looser mode (e.g.
    // 0755) would otherwise stay world-traversable.
    try { chmodSync(dir, 0o700) } catch { /* best effort */ }

    const salt = randomBytes(SALT_SIZE)
    const key = deriveKey(salt)
    const iv = randomBytes(IV_SIZE)

    const cipher = createCipheriv('aes-256-gcm', key, iv)
    const plaintext = Buffer.from(JSON.stringify(store), 'utf-8')
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
    const tag = cipher.getAuthTag()

    const header = Buffer.alloc(HEADER_SIZE)
    MAGIC.copy(header, 0)
    header.writeUInt32LE(0, 8)
    salt.copy(header, 12)

    const output = Buffer.concat([header, iv, tag, ciphertext])

    const tmpPath = `${this.filePath}.tmp`
    // SECURITY: write with O_CREAT|O_EXCL ('wx') so the temp file
    // is created atomically — if a local attacker places a symlink at tmpPath
    // in the window, openSync('wx') FAILS (rather than following the symlink as
    // writeFileSync would), closing the unlink→write TOCTOU. The .tmp is removed
    // on a prior save's cleanup, so 'wx' creates a fresh file each time.
    let fd: number
    try {
      fd = openSync(tmpPath, 'wx', 0o600)
    } catch {
      // A leftover .tmp (or a symlink an attacker placed) — remove and retry.
      try { unlinkSync(tmpPath) } catch { /* best effort if absent */ }
      fd = openSync(tmpPath, 'wx', 0o600)
    }
    try {
      writeSync(fd, output)
    } finally {
      closeSync(fd)
    }
    try { chmodSync(tmpPath, 0o600) } catch { /* best effort */ }
    try {
      renameSync(tmpPath, this.filePath)
    } catch (err) {
      try { unlinkSync(tmpPath) } catch { /* best effort */ }
      throw err
    }
  }
}

function deriveKey(salt: Buffer): Buffer {
  const machineId = getMachineId()
  const seed = createHash('sha256').update(`${machineId}:weft-credentials-v1`).digest()
  return pbkdf2Sync(seed, salt, PBKDF2_ITERATIONS, KEY_LENGTH, 'sha256')
}

function credentialKey(id: CredentialId): string {
  return `${id.type}::${id.workspaceId}::${id.sourceId}`
}

function parseCredentialKey(key: string): CredentialId | null {
  const parts = key.split('::')
  if (parts.length < 3) return null
  const type = parts[0] as CredentialId['type']
  if (!['source_oauth', 'source_bearer', 'source_apikey', 'source_basic'].includes(type)) return null
  return { type, workspaceId: parts[1]!, sourceId: parts.slice(2).join('::') }
}
