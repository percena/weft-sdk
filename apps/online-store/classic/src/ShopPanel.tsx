import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ACTION_LABELS,
  STATUS_LABELS,
  shopApi,
  type OrderAction,
  type OrderStatus,
  type ShopSnapshot,
} from './shop-api'

const STATUS_COLORS: Record<OrderStatus, string> = {
  pending_payment: 'bg-amber-100 text-amber-800',
  paid: 'bg-blue-100 text-blue-800',
  shipped: 'bg-indigo-100 text-indigo-800',
  delivered: 'bg-teal-100 text-teal-800',
  completed: 'bg-green-100 text-green-800',
  cancelled: 'bg-gray-200 text-gray-600',
  refund_requested: 'bg-orange-100 text-orange-800',
  refunded: 'bg-rose-100 text-rose-800',
}

export function ShopPanel() {
  const [snapshot, setSnapshot] = useState<ShopSnapshot | null>(null)
  const [feedError, setFeedError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const refreshInFlightRef = useRef<Promise<void> | null>(null)
  const refreshQueuedRef = useRef(false)

  // Coalescing refetch: bursts of SSE events trigger at most one in-flight
  // snapshot request plus one trailing one.
  const refresh = useCallback(async () => {
    if (refreshInFlightRef.current) {
      refreshQueuedRef.current = true
      return refreshInFlightRef.current
    }
    refreshInFlightRef.current = (async () => {
      do {
        refreshQueuedRef.current = false
        try {
          setSnapshot(await shopApi.snapshot())
        } catch (error) {
          setFeedError((error as Error).message)
        }
      } while (refreshQueuedRef.current)
      refreshInFlightRef.current = null
    })()
    return refreshInFlightRef.current
  }, [])

  useEffect(() => {
    void refresh()
    const source = new EventSource('/api/events')
    source.addEventListener('shop.event', () => {
      setFeedError(null)
      void refresh()
    })
    source.onerror = () => setFeedError('Store event stream disconnected, reconnecting…')
    return () => source.close()
  }, [refresh])

  const act = useCallback(
    async (fn: () => Promise<unknown>) => {
      setActionError(null)
      try {
        await fn()
      } catch (error) {
        setActionError((error as Error).message)
      }
      await refresh()
    },
    [refresh],
  )

  if (!snapshot) {
    return <div className="flex h-full items-center justify-center text-sm opacity-60">Loading store data…</div>
  }

  return (
    <div className="relative h-full overflow-y-auto px-5 py-4">
      {(feedError || actionError) && (
        <div className="mb-3 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">
          {feedError ?? actionError}
        </div>
      )}

      {/* products */}
      <section>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-base font-semibold">🛍️ Products</h2>
          <button type="button"
            className="rounded-md border px-2 py-1 text-xs opacity-70 hover:opacity-100"
            onClick={() => act(() => shopApi.reset())}
          >
            Reset Demo Data
          </button>
        </div>
        <div className="grid grid-cols-2 gap-3 xl:grid-cols-3">
          {snapshot.products.map((p) => (
            <div key={p.id} className="rounded-xl border bg-white p-3 shadow-sm">
              <div className="text-3xl">{p.emoji}</div>
              <div className="mt-1 font-medium">{p.name}</div>
              <div className="text-xs opacity-60">{p.description}</div>
              <div className="mt-2 flex items-center justify-between">
                <div>
                  <span className="font-semibold text-violet-700">¥{p.price}</span>
                  <span className="ml-2 text-xs opacity-50">Stock {p.stock}</span>
                </div>
                <button type="button"
                  disabled={p.stock <= 0}
                  className="rounded-md bg-violet-600 px-2.5 py-1 text-xs text-white hover:bg-violet-700 disabled:opacity-40"
                  onClick={() => act(() => shopApi.addToCart(p.id, 1))}
                >
                  Add to Cart
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* cart */}
      <section className="mt-5">
        <h2 className="mb-2 text-base font-semibold">🛒 Cart</h2>
        <div className="rounded-xl border bg-white p-3 shadow-sm">
          {snapshot.cart.items.length === 0 ? (
            <div className="py-3 text-center text-sm opacity-50">Cart is empty</div>
          ) : (
            <>
              {snapshot.cart.items.map((item) => (
                <div
                  key={item.product_id}
                  className="flex items-center justify-between border-b py-2 last:border-b-0"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-xl">{item.emoji}</span>
                    <span className="text-sm">{item.name}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <button type="button"
                      className="h-6 w-6 rounded border text-sm leading-none"
                      onClick={() => act(() => shopApi.updateCartItem(item.product_id, item.qty - 1))}
                    >
                      −
                    </button>
                    <span className="w-6 text-center text-sm">{item.qty}</span>
                    <button type="button"
                      className="h-6 w-6 rounded border text-sm leading-none"
                      onClick={() => act(() => shopApi.updateCartItem(item.product_id, item.qty + 1))}
                    >
                      +
                    </button>
                    <span className="w-16 text-right text-sm font-medium">¥{item.subtotal}</span>
                    <button type="button"
                      className="ml-1 text-xs opacity-50 hover:opacity-100"
                      onClick={() => act(() => shopApi.removeCartItem(item.product_id))}
                    >
                      ✕
                    </button>
                  </div>
                </div>
              ))}
              <div className="mt-3 flex items-center justify-between">
                <button type="button"
                  className="rounded-md border px-2.5 py-1 text-xs opacity-70 hover:opacity-100"
                  onClick={() => act(() => shopApi.clearCart())}
                >
                  Clear
                </button>
                <div className="flex items-center gap-3">
                  <span className="text-sm">
                    Total <span className="font-semibold text-violet-700">¥{snapshot.cart.total}</span>
                  </span>
                  <button type="button"
                    className="rounded-md bg-violet-600 px-3 py-1.5 text-sm text-white hover:bg-violet-700"
                    onClick={() => act(() => shopApi.checkout())}
                  >
                    Checkout
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </section>

      {/* orders */}
      <section className="mt-5 pb-8">
        <h2 className="mb-2 text-base font-semibold">📦 Orders</h2>
        {snapshot.orders.length === 0 ? (
          <div className="rounded-xl border bg-white p-4 text-center text-sm opacity-50 shadow-sm">No orders yet</div>
        ) : (
          <div className="flex flex-col gap-3">
            {snapshot.orders.map((order) => (
              <div key={order.id} className="rounded-xl border bg-white p-3 shadow-sm">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm font-semibold">{order.id}</span>
                    <span className={`rounded-full px-2 py-0.5 text-xs ${STATUS_COLORS[order.status]}`}>
                      {STATUS_LABELS[order.status]}
                    </span>
                  </div>
                  <span className="text-sm font-semibold">¥{order.total}</span>
                </div>
                <div className="mt-1 text-xs opacity-60">
                  {order.items.map((item) => `${item.emoji} ${item.name} ×${item.qty}`).join(', ')}
                </div>
                {/* state machine progress */}
                <div className="mt-2 flex flex-wrap items-center gap-1 text-[11px] opacity-70">
                  {order.history.map((entry, idx) => (
                    <span key={idx} className="flex items-center gap-1">
                      {idx > 0 && <span>→</span>}
                      <span className="rounded bg-gray-100 px-1.5 py-0.5">{STATUS_LABELS[entry.to as OrderStatus] ?? entry.to}</span>
                    </span>
                  ))}
                </div>
                {order.allowed_actions.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {order.allowed_actions.map((action: OrderAction) => (
                      <button type="button"
                        key={action}
                        className="rounded-md border px-2.5 py-1 text-xs hover:bg-violet-50"
                        onClick={() => act(() => shopApi.orderAction(order.id, action))}
                      >
                        {ACTION_LABELS[action]}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
