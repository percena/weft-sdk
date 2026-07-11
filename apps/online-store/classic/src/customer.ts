const STORAGE_KEY = 'online-store-customer-id'

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

export function setCustomerId(id: string) {
  _customerId = id
}
