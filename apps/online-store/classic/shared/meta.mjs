// Single source of truth for the order state machine and its labels.
// Consumed by the shop backend (server/state.mjs) and the frontend
// (src/shop-api.ts) so the two layers can never drift apart.

export const ORDER_STATES = [
  "pending_payment",
  "paid",
  "shipped",
  "delivered",
  "completed",
  "cancelled",
  "refund_requested",
  "refunded",
];

// action name -> { from: [states], to: state | "$prior" }
export const TRANSITIONS = {
  pay: { from: ["pending_payment"], to: "paid" },
  cancel: { from: ["pending_payment", "paid"], to: "cancelled" },
  ship: { from: ["paid"], to: "shipped" },
  deliver: { from: ["shipped"], to: "delivered" },
  confirm: { from: ["delivered"], to: "completed" },
  request_refund: { from: ["paid", "shipped", "delivered"], to: "refund_requested" },
  approve_refund: { from: ["refund_requested"], to: "refunded" },
  deny_refund: { from: ["refund_requested"], to: "$prior" },
};

export function allowedActions(status) {
  return Object.keys(TRANSITIONS).filter((action) => TRANSITIONS[action].from.includes(status));
}

export const STATUS_LABELS = {
  pending_payment: "Pending Payment",
  paid: "Paid",
  shipped: "Shipped",
  delivered: "Delivered",
  completed: "Completed",
  cancelled: "Cancelled",
  refund_requested: "Refund Requested",
  refunded: "Refunded",
};

export const ACTION_LABELS = {
  pay: "Pay",
  cancel: "Cancel Order",
  ship: "Ship",
  deliver: "Deliver",
  confirm: "Confirm Receipt",
  request_refund: "Request Refund",
  approve_refund: "Approve Refund",
  deny_refund: "Deny Refund",
};

export const ACTION_PATHS = {
  pay: (id) => `/api/orders/${id}/pay`,
  cancel: (id) => `/api/orders/${id}/cancel`,
  ship: (id) => `/api/orders/${id}/ship`,
  deliver: (id) => `/api/orders/${id}/deliver`,
  confirm: (id) => `/api/orders/${id}/confirm`,
  request_refund: (id) => `/api/orders/${id}/refund/request`,
  approve_refund: (id) => `/api/orders/${id}/refund/approve`,
  deny_refund: (id) => `/api/orders/${id}/refund/deny`,
};
