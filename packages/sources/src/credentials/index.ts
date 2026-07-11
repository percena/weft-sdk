import type { CredentialId, StoredCredential } from './types.ts'
import { EncryptedCredentialBackend } from './encrypted-backend.ts'

export type { CredentialId, StoredCredential } from './types.ts'
export { EncryptedCredentialBackend } from './encrypted-backend.ts'
export { getMachineId } from './machine-id.ts'

export interface CredentialManager {
  get(id: CredentialId): Promise<StoredCredential | null>
  set(id: CredentialId, credential: StoredCredential): Promise<void>
  delete(id: CredentialId): Promise<boolean>
}

class InMemoryCredentialManager implements CredentialManager {
  private store = new Map<string, StoredCredential>()

  private key(id: CredentialId): string {
    return `${id.type}::${id.workspaceId}::${id.sourceId}`
  }

  async get(id: CredentialId): Promise<StoredCredential | null> {
    return this.store.get(this.key(id)) ?? null
  }

  async set(id: CredentialId, credential: StoredCredential): Promise<void> {
    this.store.set(this.key(id), credential)
  }

  async delete(id: CredentialId): Promise<boolean> {
    return this.store.delete(this.key(id))
  }
}

export { InMemoryCredentialManager }

export interface CreateCredentialManagerOptions {
  backend?: 'encrypted' | 'memory'
  filePath?: string
}

let instance: CredentialManager | null = null

export function getCredentialManager(options?: CreateCredentialManagerOptions): CredentialManager {
  if (!instance) {
    const backend = options?.backend ?? 'encrypted'
    if (backend === 'memory') {
      instance = new InMemoryCredentialManager()
    } else {
      instance = new EncryptedCredentialBackend(options?.filePath)
    }
  }
  return instance
}

export function resetCredentialManager(): void {
  instance = null
}
