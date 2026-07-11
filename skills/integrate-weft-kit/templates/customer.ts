// Per-browser guest id used as the weftd end_user_id when no one is logged in.
// Persisted so a returning guest keeps the same id (and the same cart/state
// across reloads). The storage key is namespaced to {{appSlug}} so concurrent
// apps on the same origin don't collide.
const STORAGE_KEY = '{{appSlug}}-customer-id'

function resolveGuestId(): string {
  try {
    const existing = window.localStorage.getItem(STORAGE_KEY)
    if (existing) return existing
    const fresh = `cust_${Math.random().toString(36).slice(2, 10)}`
    window.localStorage.setItem(STORAGE_KEY, fresh)
    return fresh
  } catch {
    return 'guest'
  }
}

export const guestId = resolveGuestId()

let _customerId = guestId

export function getCustomerId(): string {
  return _customerId
}

export function setCustomerId(id: string): void {
  _customerId = id
}
