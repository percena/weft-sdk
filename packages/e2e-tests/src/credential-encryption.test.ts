import { describe, expect, test, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  EncryptedCredentialBackend,
  getMachineId,
  type CredentialId,
  type StoredCredential,
} from '@weft/sources'

const TEST_DIR = join(tmpdir(), `weft-cred-test-${Date.now()}`)
const TEST_FILE = join(TEST_DIR, 'credentials.enc')

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true })
})

afterEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true })
})

const testId: CredentialId = {
  type: 'source_oauth',
  workspaceId: 'ws-1',
  sourceId: 'github',
}

const testCred: StoredCredential = {
  value: 'gho_supersecrettoken123',
  refreshToken: 'ghr_refreshme',
  expiresAt: Date.now() + 3600_000,
  clientId: 'client-abc',
  tokenType: 'Bearer',
}

describe('Machine ID', () => {
  test('returns a non-empty string', () => {
    const id = getMachineId()
    expect(typeof id).toBe('string')
    expect(id.length).toBeGreaterThan(0)
  })

  test('returns stable value across calls', () => {
    expect(getMachineId()).toBe(getMachineId())
  })
})

describe('EncryptedCredentialBackend', () => {
  test('get returns null for missing credential', async () => {
    const backend = new EncryptedCredentialBackend(TEST_FILE)
    const result = await backend.get(testId)
    expect(result).toBeNull()
  })

  test('set and get round-trip', async () => {
    const backend = new EncryptedCredentialBackend(TEST_FILE)
    await backend.set(testId, testCred)

    const result = await backend.get(testId)
    expect(result).toEqual(testCred)
  })

  test('persists to disk and loads from new instance', async () => {
    const backend1 = new EncryptedCredentialBackend(TEST_FILE)
    await backend1.set(testId, testCred)

    const backend2 = new EncryptedCredentialBackend(TEST_FILE)
    const result = await backend2.get(testId)
    expect(result).toEqual(testCred)
  })

  test('file is encrypted (not plaintext)', async () => {
    const backend = new EncryptedCredentialBackend(TEST_FILE)
    await backend.set(testId, testCred)

    const raw = readFileSync(TEST_FILE)
    const text = raw.toString('utf-8')
    expect(text).not.toContain('gho_supersecrettoken123')
    expect(text).not.toContain('refreshme')
  })

  test('file starts with WEFT01 magic', async () => {
    const backend = new EncryptedCredentialBackend(TEST_FILE)
    await backend.set(testId, testCred)

    const raw = readFileSync(TEST_FILE)
    expect(raw.subarray(0, 6).toString('utf-8')).toBe('WEFT01')
  })

  test('delete removes credential', async () => {
    const backend = new EncryptedCredentialBackend(TEST_FILE)
    await backend.set(testId, testCred)

    const deleted = await backend.delete(testId)
    expect(deleted).toBe(true)

    const result = await backend.get(testId)
    expect(result).toBeNull()
  })

  test('delete returns false for missing credential', async () => {
    const backend = new EncryptedCredentialBackend(TEST_FILE)
    const deleted = await backend.delete(testId)
    expect(deleted).toBe(false)
  })

  test('stores multiple credentials independently', async () => {
    const backend = new EncryptedCredentialBackend(TEST_FILE)

    const id2: CredentialId = { type: 'source_apikey', workspaceId: 'ws-1', sourceId: 'slack' }
    const cred2: StoredCredential = { value: 'xoxb-slack-token' }

    await backend.set(testId, testCred)
    await backend.set(id2, cred2)

    expect(await backend.get(testId)).toEqual(testCred)
    expect(await backend.get(id2)).toEqual(cred2)
  })

  test('list returns stored credential IDs', async () => {
    const backend = new EncryptedCredentialBackend(TEST_FILE)

    const id2: CredentialId = { type: 'source_apikey', workspaceId: 'ws-2', sourceId: 'slack' }
    await backend.set(testId, testCred)
    await backend.set(id2, { value: 'tok' })

    const all = await backend.list()
    expect(all).toHaveLength(2)

    const filtered = await backend.list({ workspaceId: 'ws-1' })
    expect(filtered).toHaveLength(1)
    expect(filtered[0]!.sourceId).toBe('github')
  })

  test('overwrites existing credential', async () => {
    const backend = new EncryptedCredentialBackend(TEST_FILE)
    await backend.set(testId, testCred)
    await backend.set(testId, { value: 'new-token' })

    const result = await backend.get(testId)
    expect(result!.value).toBe('new-token')
    expect(result!.refreshToken).toBeUndefined()
  })

  test('creates directory if missing', async () => {
    const deepPath = join(TEST_DIR, 'a', 'b', 'c', 'credentials.enc')
    const backend = new EncryptedCredentialBackend(deepPath)
    await backend.set(testId, testCred)

    expect(existsSync(deepPath)).toBe(true)
    const result = await backend.get(testId)
    expect(result).toEqual(testCred)
  })
})
