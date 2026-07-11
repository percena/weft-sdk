import { test } from "node:test";
import assert from "node:assert/strict";

import { createShopServer } from "./shop-server.mjs";
import { createShopState } from "./state.mjs";

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server.address().port);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.closeAllConnections?.(); // drop any lingering SSE/keep-alive sockets
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function createClient(baseUrl) {
  let cookie = "";
  return {
    async request(method, path, body, extraHeaders = {}) {
      const headers = { "content-type": "application/json", ...extraHeaders };
      if (cookie) headers.cookie = cookie;
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const setCookie = response.headers.get("set-cookie");
      if (setCookie) {
        const match = setCookie.match(/shop_session=([^;]*)/);
        cookie = match?.[1] ? `shop_session=${match[1]}` : "";
      }
      const data = await response.json();
      if (!response.ok) {
        throw new Error(`${method} ${path} -> ${response.status}: ${JSON.stringify(data)}`);
      }
      return data;
    },
  };
}

test("shop API falls back to logged-in cookie identity when customer headers are absent", async () => {
  const state = createShopState();
  const server = createShopServer({ state });
  const port = await listen(server);
  const client = createClient(`http://127.0.0.1:${port}`);

  try {
    await client.request("POST", "/api/login", { username: "alice" });
    await client.request("POST", "/api/cart/items", { product_id: "p1", qty: 1 });

    assert.equal(state.cartView("alice").items.length, 1);
    assert.equal(state.cartView("guest").items.length, 0);
  } finally {
    await close(server);
  }
});

test("shop API only trusts runtime-stamped X-Weft-Actor for agent attribution", async () => {
  const state = createShopState();
  const events = [];
  state.onEvent((event) => events.push(event));
  const server = createShopServer({ state });
  const port = await listen(server);
  const client = createClient(`http://127.0.0.1:${port}`);

  try {
    await client.request("POST", "/api/cart/items", { product_id: "p1", qty: 1 }, { "x-actor": "agent" });
    await client.request("POST", "/api/cart/items", { product_id: "p2", qty: 1 }, { "x-weft-actor": "agent" });

    assert.deepEqual(events.map((event) => [event.action, event.actor]), [
      ["cart.item_added", "user"],
      ["cart.item_added", "agent"],
    ]);
  } finally {
    await close(server);
  }
});

test("CORS preflight permits Content-Encoding", async () => {
  const server = createShopServer();
  const port = await listen(server);

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/state`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://embed.example",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-encoding, authorization",
      },
    });

    assert.equal(response.status, 204);
    assert.match(response.headers.get("access-control-allow-headers") ?? "", /content-encoding/i);
  } finally {
    await close(server);
  }
});

test("POST /api/reset requires a logged-in session (no anonymous reset)", async () => {
  const server = createShopServer();
  const port = await listen(server);

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/reset`, {
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    assert.equal(response.status, 401);
  } finally {
    await close(server);
  }
});

