export interface Product {
  id: string
  name: string
  name_en: string
  price: number
  stock: number
  emoji: string
  description: string
}

export interface CartItem {
  product_id: string
  name: string
  name_en: string
  emoji: string
  unit_price: number
  qty: number
  subtotal: number
}

export interface Cart {
  customer_id: string
  items: CartItem[]
  total: number
}

export type OrderStatus =
  | 'pending_payment'
  | 'paid'
  | 'shipped'
  | 'delivered'
  | 'completed'
  | 'cancelled'
  | 'refund_requested'
  | 'refunded'

export type OrderAction =
  | 'pay'
  | 'cancel'
  | 'ship'
  | 'deliver'
  | 'confirm'
  | 'request_refund'
  | 'approve_refund'
  | 'deny_refund'

export interface Order {
  id: string
  customer_id: string
  items: Array<{ product_id: string; name: string; emoji: string; unit_price: number; qty: number; subtotal: number }>
  total: number
  status: OrderStatus
  history: Array<{ action: string; from: string | null; to: string; at: number }>
  allowed_actions: OrderAction[]
  created_at: number
  updated_at: number
}

export interface ShopSnapshot {
  products: Product[]
  cart: Cart
  orders: Order[]
}

export interface ShopEvent {
  id: string
  ts: number
  actor: 'agent' | 'user' | 'system'
  action: string
  data: Record<string, any>
}

// Labels and action paths come from the shared state-machine metadata so the
// frontend and the shop backend can never drift apart.
import {
  STATUS_LABELS as SHARED_STATUS_LABELS,
  ACTION_LABELS as SHARED_ACTION_LABELS,
  ACTION_PATHS as SHARED_ACTION_PATHS,
} from '../shared/meta.mjs'

export const STATUS_LABELS = SHARED_STATUS_LABELS as Record<OrderStatus, string>
export const ACTION_LABELS = SHARED_ACTION_LABELS as Record<OrderAction, string>
export const ACTION_PATHS = SHARED_ACTION_PATHS as Record<OrderAction, (id: string) => string>

import { getCustomerId } from './customer'

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json', 'X-Customer-ID': getCustomerId() },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const data = await response.json()
  if (!response.ok) {
    throw new Error((data as { error?: string }).error ?? `HTTP ${response.status}`)
  }
  return data as T
}

export const shopApi = {
  snapshot: () => request<ShopSnapshot>('GET', '/api/state'),
  addToCart: (productId: string, qty: number) =>
    request<Cart>('POST', '/api/cart/items', { product_id: productId, qty }),
  updateCartItem: (productId: string, qty: number) =>
    request<Cart>('PATCH', `/api/cart/items/${productId}`, { qty }),
  removeCartItem: (productId: string) => request<Cart>('DELETE', `/api/cart/items/${productId}`),
  clearCart: () => request<Cart>('DELETE', '/api/cart'),
  checkout: () => request<{ order: Order }>('POST', '/api/orders'),
  orderAction: (orderId: string, action: OrderAction) =>
    request<{ order: Order }>('POST', ACTION_PATHS[action](orderId)),
  reset: () => request<{ ok: boolean }>('POST', '/api/reset'),
}
