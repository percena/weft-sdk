// In-memory shop state: product catalog, per-customer carts, and orders with
// a guarded state machine. The shop server is intentionally dependency-free.

import { ORDER_STATES, TRANSITIONS, allowedActions } from "../shared/meta.mjs";

export { ORDER_STATES, TRANSITIONS, allowedActions };

const SEED_PRODUCTS = [
  { id: "p1", name: "Mechanical Keyboard", name_en: "Mechanical Keyboard", price: 399, stock: 12, emoji: "⌨️", description: "87-key hot-swappable, Gateron Red switches" },
  { id: "p2", name: "Wireless Mouse", name_en: "Wireless Mouse", price: 159, stock: 20, emoji: "🖱️", description: "2.4G + Bluetooth dual-mode, silent microswitches" },
  { id: "p3", name: "Noise-Cancelling Headphones", name_en: "Noise-Cancelling Headphones", price: 899, stock: 8, emoji: "🎧", description: "Active noise cancellation, 40-hour battery life" },
  { id: "p4", name: "Smart Watch", name_en: "Smart Watch", price: 1299, stock: 5, emoji: "⌚", description: "Blood oxygen + heart rate monitoring, eSIM standalone calling" },
  { id: "p5", name: "Portable Monitor", name_en: "Portable Monitor", price: 1099, stock: 6, emoji: "🖥️", description: "15.6-inch 1080P, single Type-C cable" },
  { id: "p6", name: "Desktop Speaker", name_en: "Desktop Speaker", price: 249, stock: 15, emoji: "🔊", description: "Wooden cabinet, Bluetooth 5.3" },
];

export function createShopState({ now = () => Date.now() } = {}) {
  let products = [];
  let carts = new Map(); // customerId -> [{ product_id, qty }]
  let orders = new Map(); // orderId -> order
  let orderSeq = 0;
  const listeners = new Set();

  function reset() {
    products = SEED_PRODUCTS.map((p) => ({ ...p }));
    carts = new Map();
    orders = new Map();
    orderSeq = 0;
  }
  reset();

  function emit(actor, action, data) {
    const event = { id: `evt-${now()}-${Math.random().toString(36).slice(2, 8)}`, ts: now(), actor, action, data };
    for (const fn of listeners) fn(event);
    return event;
  }

  function onEvent(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  const httpError = (status, message, extra = {}) =>
    Object.assign(new Error(message), { status, extra });

  function getProduct(id) {
    const product = products.find((p) => p.id === id);
    if (!product) throw httpError(404, `product not found: ${id}`);
    return product;
  }

  function listProducts() {
    return products.map((p) => ({ ...p }));
  }

  function updateProduct(id, patch, actor) {
    const product = getProduct(id);
    if (patch.price !== undefined) {
      if (typeof patch.price !== "number" || patch.price <= 0) throw httpError(400, "price must be a positive number");
      product.price = patch.price;
    }
    if (patch.stock !== undefined) {
      if (!Number.isInteger(patch.stock) || patch.stock < 0) throw httpError(400, "stock must be a non-negative integer");
      product.stock = patch.stock;
    }
    if (patch.description !== undefined) product.description = String(patch.description);
    emit(actor, "product.updated", { product: { ...product } });
    return { ...product };
  }

  function cartFor(customerId) {
    if (!carts.has(customerId)) carts.set(customerId, []);
    return carts.get(customerId);
  }

  function cartView(customerId) {
    const items = cartFor(customerId).map((item) => {
      const product = getProduct(item.product_id);
      return {
        product_id: item.product_id,
        name: product.name,
        name_en: product.name_en,
        emoji: product.emoji,
        unit_price: product.price,
        qty: item.qty,
        subtotal: product.price * item.qty,
      };
    });
    return {
      customer_id: customerId,
      items,
      total: items.reduce((sum, item) => sum + item.subtotal, 0),
    };
  }

  function addCartItem(customerId, productId, qty, actor) {
    if (!Number.isInteger(qty) || qty <= 0) throw httpError(400, "qty must be a positive integer");
    const product = getProduct(productId);
    const cart = cartFor(customerId);
    const existing = cart.find((item) => item.product_id === productId);
    const newQty = (existing?.qty ?? 0) + qty;
    if (newQty > product.stock) {
      throw httpError(409, `insufficient stock for ${product.name}: requested ${newQty}, in stock ${product.stock}`);
    }
    if (existing) existing.qty = newQty;
    else cart.push({ product_id: productId, qty });
    emit(actor, "cart.item_added", { customer_id: customerId, product_id: productId, name: product.name, qty, cart: cartView(customerId) });
    return cartView(customerId);
  }

  function updateCartItem(customerId, productId, qty, actor) {
    if (!Number.isInteger(qty) || qty < 0) throw httpError(400, "qty must be a non-negative integer");
    const cart = cartFor(customerId);
    const existing = cart.find((item) => item.product_id === productId);
    if (!existing) throw httpError(404, `cart item not found: ${productId}`);
    if (qty === 0) return removeCartItem(customerId, productId, actor);
    const product = getProduct(productId);
    if (qty > product.stock) throw httpError(409, `insufficient stock for ${product.name}: requested ${qty}, in stock ${product.stock}`);
    existing.qty = qty;
    emit(actor, "cart.item_updated", { customer_id: customerId, product_id: productId, name: product.name, qty, cart: cartView(customerId) });
    return cartView(customerId);
  }

  function removeCartItem(customerId, productId, actor) {
    const cart = cartFor(customerId);
    const index = cart.findIndex((item) => item.product_id === productId);
    if (index === -1) throw httpError(404, `cart item not found: ${productId}`);
    const [removed] = cart.splice(index, 1);
    const product = products.find((p) => p.id === productId);
    emit(actor, "cart.item_removed", { customer_id: customerId, product_id: productId, name: product?.name ?? productId, qty: removed.qty, cart: cartView(customerId) });
    return cartView(customerId);
  }

  function clearCart(customerId, actor) {
    carts.set(customerId, []);
    emit(actor, "cart.cleared", { customer_id: customerId, cart: cartView(customerId) });
    return cartView(customerId);
  }

  function createOrder(customerId, actor) {
    const cart = cartFor(customerId);
    if (cart.length === 0) throw httpError(409, "cart is empty; add items before checkout");

    // Validate stock for the whole cart before reserving any of it.
    for (const item of cart) {
      const product = getProduct(item.product_id);
      if (item.qty > product.stock) {
        throw httpError(409, `insufficient stock for ${product.name}: requested ${item.qty}, in stock ${product.stock}`);
      }
    }

    const items = cart.map((item) => {
      const product = getProduct(item.product_id);
      product.stock -= item.qty;
      return { product_id: product.id, name: product.name, emoji: product.emoji, unit_price: product.price, qty: item.qty, subtotal: product.price * item.qty };
    });

    orderSeq += 1;
    const order = {
      id: `ORD-${orderSeq}`,
      customer_id: customerId,
      items,
      total: items.reduce((sum, item) => sum + item.subtotal, 0),
      status: "pending_payment",
      prior_status: null,
      history: [{ action: "create", from: null, to: "pending_payment", at: now() }],
      created_at: now(),
      updated_at: now(),
    };
    orders.set(order.id, order);
    carts.set(customerId, []);
    emit(actor, "order.created", { order: orderView(order) });
    return orderView(order);
  }

  function orderView(order) {
    // prior_status is internal bookkeeping for deny_refund; keep it out of
    // the API contract.
    const { prior_status: _prior, ...view } = order;
    return { ...view, items: order.items.map((item) => ({ ...item })), history: order.history.map((entry) => ({ ...entry })), allowed_actions: allowedActions(order.status) };
  }

  function getOrder(id) {
    const order = orders.get(id);
    if (!order) throw httpError(404, `order not found: ${id}`);
    return order;
  }

  function listOrders({ customerId, status } = {}) {
    return [...orders.values()]
      .filter((order) => (customerId ? order.customer_id === customerId : true))
      .filter((order) => (status ? order.status === status : true))
      .sort((a, b) => b.created_at - a.created_at)
      .map(orderView);
  }

  function restock(order) {
    for (const item of order.items) {
      const product = products.find((p) => p.id === item.product_id);
      if (product) product.stock += item.qty;
    }
  }

  function transitionOrder(id, action, actor) {
    const order = getOrder(id);
    const rule = TRANSITIONS[action];
    if (!rule) throw httpError(400, `unknown action: ${action}`);
    if (!rule.from.includes(order.status)) {
      throw httpError(409, `cannot ${action} order ${id} in status ${order.status}`, { allowed_actions: allowedActions(order.status) });
    }

    const from = order.status;
    const to = rule.to === "$prior" ? order.prior_status : rule.to;
    if (!to) throw httpError(409, `order ${id} has no prior status to return to`);

    if (action === "request_refund") order.prior_status = from;
    if (rule.to === "$prior") order.prior_status = null;
    if (action === "cancel" || action === "approve_refund") restock(order);

    order.status = to;
    order.updated_at = now();
    order.history.push({ action, from, to, at: now() });
    emit(actor, "order.transitioned", { order: orderView(order), action, from, to });
    return orderView(order);
  }

  function snapshot(customerId) {
    return {
      products: listProducts(),
      cart: cartView(customerId),
      orders: listOrders({ customerId }),
    };
  }

  return {
    reset: (actor = "system") => { reset(); emit(actor, "shop.reset", {}); },
    onEvent,
    listProducts,
    getProduct: (id) => ({ ...getProduct(id) }),
    updateProduct,
    cartView,
    addCartItem,
    updateCartItem,
    removeCartItem,
    clearCart,
    createOrder,
    listOrders,
    getOrder: (id) => orderView(getOrder(id)),
    transitionOrder,
    snapshot,
  };
}
