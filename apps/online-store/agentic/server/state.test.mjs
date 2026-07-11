import { test } from "node:test";
import assert from "node:assert/strict";

import { createShopState, allowedActions } from "./state.mjs";

function stateWithOrder() {
  const state = createShopState();
  state.addCartItem("guest", "p1", 2, "user");
  const order = state.createOrder("guest", "user");
  return { state, order };
}

test("cart add/update/remove and totals", () => {
  const state = createShopState();
  state.addCartItem("guest", "p1", 1, "user");
  state.addCartItem("guest", "p1", 1, "user");
  state.addCartItem("guest", "p2", 3, "user");
  let cart = state.cartView("guest");
  assert.equal(cart.items.length, 2);
  assert.equal(cart.items[0].qty, 2);
  assert.equal(cart.total, 399 * 2 + 159 * 3);

  cart = state.updateCartItem("guest", "p2", 1, "user");
  assert.equal(cart.total, 399 * 2 + 159);

  cart = state.removeCartItem("guest", "p1", "user");
  assert.equal(cart.items.length, 1);

  cart = state.updateCartItem("guest", "p2", 0, "user");
  assert.equal(cart.items.length, 0);
});

test("carts are isolated per customer", () => {
  const state = createShopState();
  state.addCartItem("alice", "p1", 1, "user");
  state.addCartItem("bob", "p2", 2, "user");
  assert.equal(state.cartView("alice").items.length, 1);
  assert.equal(state.cartView("bob").items[0].product_id, "p2");
});

test("checkout reserves stock and clears the cart", () => {
  const state = createShopState();
  state.addCartItem("guest", "p4", 2, "user");
  const order = state.createOrder("guest", "user");
  assert.equal(order.status, "pending_payment");
  assert.equal(order.total, 1299 * 2);
  assert.equal(state.getProduct("p4").stock, 3);
  assert.equal(state.cartView("guest").items.length, 0);
});

test("checkout with empty cart is rejected", () => {
  const state = createShopState();
  assert.throws(() => state.createOrder("guest", "user"), /cart is empty/);
});

test("stock guard on add and checkout", () => {
  const state = createShopState();
  assert.throws(() => state.addCartItem("guest", "p4", 6, "user"), /insufficient stock/);
  state.addCartItem("guest", "p4", 5, "user");
  assert.throws(() => state.addCartItem("guest", "p4", 1, "user"), /insufficient stock/);
});

test("happy path: pay -> ship -> deliver -> confirm", () => {
  const { state, order } = stateWithOrder();
  assert.equal(state.transitionOrder(order.id, "pay", "user").status, "paid");
  assert.equal(state.transitionOrder(order.id, "ship", "user").status, "shipped");
  assert.equal(state.transitionOrder(order.id, "deliver", "user").status, "delivered");
  const done = state.transitionOrder(order.id, "confirm", "user");
  assert.equal(done.status, "completed");
  assert.deepEqual(done.allowed_actions, []);
  assert.equal(done.history.length, 5);
});

test("cancel before payment restores stock", () => {
  const { state, order } = stateWithOrder();
  assert.equal(state.getProduct("p1").stock, 10);
  state.transitionOrder(order.id, "cancel", "user");
  assert.equal(state.getProduct("p1").stock, 12);
});

test("cancel after shipping is rejected with allowed actions", () => {
  const { state, order } = stateWithOrder();
  state.transitionOrder(order.id, "pay", "user");
  state.transitionOrder(order.id, "ship", "user");
  try {
    state.transitionOrder(order.id, "cancel", "user");
    assert.fail("expected transition error");
  } catch (error) {
    assert.equal(error.status, 409);
    assert.deepEqual(error.extra.allowed_actions, ["deliver", "request_refund"]);
  }
});

test("refund request/deny returns to prior status; approve restocks", () => {
  const { state, order } = stateWithOrder();
  state.transitionOrder(order.id, "pay", "user");
  state.transitionOrder(order.id, "ship", "user");
  assert.equal(state.transitionOrder(order.id, "request_refund", "user").status, "refund_requested");
  assert.equal(state.transitionOrder(order.id, "deny_refund", "user").status, "shipped");

  state.transitionOrder(order.id, "request_refund", "user");
  const refunded = state.transitionOrder(order.id, "approve_refund", "user");
  assert.equal(refunded.status, "refunded");
  assert.equal(state.getProduct("p1").stock, 12);
});

test("allowedActions matches the transition table", () => {
  assert.deepEqual(allowedActions("pending_payment"), ["pay", "cancel"]);
  assert.deepEqual(allowedActions("paid"), ["cancel", "ship", "request_refund"]);
  assert.deepEqual(allowedActions("refunded"), []);
});

test("events are emitted with the acting party", () => {
  const state = createShopState();
  const events = [];
  state.onEvent((event) => events.push(event));
  state.addCartItem("guest", "p1", 1, "agent");
  state.createOrder("guest", "agent");
  assert.deepEqual(events.map((event) => [event.action, event.actor]), [
    ["cart.item_added", "agent"],
    ["order.created", "agent"],
  ]);
  assert.equal(events[1].data.order.status, "pending_payment");
});
