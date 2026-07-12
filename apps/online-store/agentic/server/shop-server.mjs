// Online Store (agentic) backend: REST CRUD + order state machine + SSE event
// feed, with the weftd chat-session backend + /v1 reverse proxy wired in via the
// integrate-weft-kit skill's modular templates (provision.mjs + session-routes.mjs).
// Run: node run.mjs (SHOP_PORT to override; WEFTD_BASE/WEFT_API_KEY/WEFT_TENANT_ID required).

import crypto from "node:crypto";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

import { createShopState } from "./state.mjs";
import { createProvisioning } from "./provision.mjs";
import { wireSessionRoutes } from "./session-routes.mjs";
import { buildShopSystemPrompt } from "../lib/system-prompt.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const webDist = join(__dirname, "..", "dist");

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
};

// CORS origin policy. Never use `*` with cookie-authenticated sessions — it
// is inert for credentialed cross-origin fetches and signals "wide open" to
// integrators copying this template. Reflect the request Origin against
// `DEMO_CORS_ORIGIN` (comma-separated exact origins); an explicit allowlist
// match enables `Access-Control-Allow-Credentials`. Unset = dev-only permissive
// reflection WITHOUT credentials — equivalent to `*` for non-credentialed
// reads, inert for credentialed, so it never widens the cookie surface.
// Production MUST set DEMO_CORS_ORIGIN to its exact origins.
//
// SECURITY: read DEMO_CORS_ORIGIN PER REQUEST, not at module import
// time. ESM imports resolve before run.mjs's `Object.assign(process.env,
// loadEnv())` populates process.env from .env, so a module-scope const would be
// captured empty → the configured allowlist would be silently [] at runtime,
// falling through to permissive any-origin reflection. Evaluating per-request
// guarantees the allowlist is actually applied.
function corsAllowOrigins() {
  return (process.env.DEMO_CORS_ORIGIN ?? "")
    .split(",").map((s) => s.trim()).filter(Boolean);
}
function corsPolicy(origin) {
  if (!origin) return null; // same-origin / non-browser — no ACAO needed
  const allow = corsAllowOrigins();
  if (allow.length) {
    return allow.includes(origin)
      ? { origin, credentials: true }
      : null;
  }
  return { origin, credentials: false }; // dev-only permissive reflection (no credentials)
}

// Body + connection caps to prevent resource-exhaustion DoS.
const MAX_JSON_BODY = 1 << 20;    // 1 MiB for JSON API bodies
const MAX_SSE_PER_IP = 12;        // concurrent SSE connections per client IP
const MAX_SSE_GLOBAL = 240;       // global concurrent SSE connections
// SECURITY: only trust X-Forwarded-For when behind a configured
// trusted proxy that overwrites it (DEMO_TRUSTED_PROXY=1); otherwise use the
// socket remote address so an attacker can't rotate XFF to bypass the per-IP cap.
// Read PER REQUEST, NOT at module import time — ESM imports resolve before
// run.mjs's `Object.assign(process.env, loadEnv())` populates process.env from
// .env, so a module-scope const would be captured empty (false) → the trusted-
// proxy feature would be dead on arrival from .env. Same bug class as the CORS
// allowlist above; evaluates per-request so the flag is actually applied.
function clientIp(req) {
  if (process.env.DEMO_TRUSTED_PROXY === "1") {
    const xff = req.headers["x-forwarded-for"];
    if (typeof xff === "string" && xff) return xff.split(",")[0].trim();
  }
  return req.socket.remoteAddress ?? "";
}

// Extract the owning customer from a shop event: cart events carry
// data.customer_id, order events carry data.order.customer_id, and product /
// shop.reset events are global (no customer_id). The SSE fan-out uses this to
// send each connection only its own customer-scoped events — a connection
// asserting customerId "bob" never receives "alice"'s cart/order events.
function eventCustomerId(event) {
  return event?.data?.customer_id ?? event?.data?.order?.customer_id ?? null;
}

export function createShopServer({ state = createShopState() } = {}) {
  const sseClients = new Set();

  // --- Simple cookie-based login (L1 auth simulation) ---
  const sessions = new Map(); // sessionToken -> { username }

  function parseCookies(req) {
    const header = req.headers.cookie ?? "";
    const out = {};
    for (const part of header.split(";")) {
      const eq = part.indexOf("=");
      if (eq === -1) continue;
      out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
    }
    return out;
  }

  function getLoggedInUser(req) {
    const token = parseCookies(req).shop_session;
    return token ? sessions.get(token) ?? null : null;
  }

  // Per-customer SSE fan-out. NOTE: state.onEvent APPENDS (Set-based, not
  // replaces), so when weftd is configured wireSessionRoutes registers a SECOND
  // fan-out — both fire (a duplicated write to each matching client; no leak, no
  // miss). The filter scopes each connection to its own customer's cart/order
  // events; global events (product.updated, shop.reset) go to everyone.
  state.onEvent((event) => {
    const payload = `event: shop.event\ndata: ${JSON.stringify(event)}\n\n`;
    const ecid = eventCustomerId(event);
    for (const res of [...sseClients]) {
      if (res.destroyed || res.writableEnded) {
        sseClients.delete(res);
        continue;
      }
      if (ecid && res.weftCustomerId && res.weftCustomerId !== ecid) continue;
      try {
        res.write(payload);
      } catch {
        sseClients.delete(res);
      }
    }
  });

  const server = createServer(async (req, res) => {
    const cors = corsPolicy(req.headers.origin);
    if (cors) {
      res.setHeader("Access-Control-Allow-Origin", cors.origin);
      if (cors.credentials) res.setHeader("Access-Control-Allow-Credentials", "true");
    }
    // Vary by Origin whenever an Origin was sent, even when we did NOT add
    // Access-Control-Allow-Origin: a CDN without `Vary: Origin` could cache a
    // CORS-less response and serve it to a legitimately-allowlisted origin.
    if (req.headers.origin) res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,PUT,DELETE,OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Content-Encoding, Authorization, X-Customer-ID, X-Weft-Actor, X-Weft-Session, X-Weft-End-User, X-Weft-App, X-Weft-External-Account, X-Weft-External-User",
    );
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      return res.end();
    }

    const url = new URL(req.url, "http://localhost");
    // X-Weft-Actor is stamped by the Weft browser runtime for client-side tool calls.
    const actor = req.headers["x-weft-actor"] === "agent" ? "agent" : "user";
    const loggedInUser = getLoggedInUser(req);
    // The authenticated session is authoritative: a logged-in user's carts/orders
    // are scoped to their own username and cannot be reassigned by a
    // client-supplied header (which would be an IDOR — read/write another
    // customer's data via `X-Customer-ID: <victim>`). The X-Customer-ID /
    // X-Weft-End-User headers only name the customer for anonymous browsing; when
    // the agent drives tools client-side it carries the user's session cookie, so
    // loggedInUser is set and its username wins.
    const customerId = loggedInUser?.username ?? String(req.headers["x-customer-id"] ?? req.headers["x-weft-end-user"] ?? "guest");

    try {
      // --- Login / logout / me (L1 auth simulation) ---
      if (url.pathname === "/api/login" && req.method === "POST") {
        const body = await readJSON(req);
        const username = String(body.username ?? "").trim();
        if (!username) return writeJSON(res, 400, { error: "username is required" });
        const token = crypto.randomUUID();
        sessions.set(token, { username });
        res.setHeader("Set-Cookie", `shop_session=${token}; Path=/; HttpOnly; SameSite=Lax`);
        return writeJSON(res, 200, { username });
      }
      if (url.pathname === "/api/logout" && req.method === "POST") {
        const token = parseCookies(req).shop_session;
        if (token) sessions.delete(token);
        res.setHeader("Set-Cookie", "shop_session=; Path=/; HttpOnly; Max-Age=0");
        return writeJSON(res, 200, { ok: true });
      }
      if (url.pathname === "/api/me" && req.method === "GET") {
        const user = loggedInUser;
        if (!user) return writeJSON(res, 401, { error: "not logged in" });
        return writeJSON(res, 200, { username: user.username });
      }

      if (url.pathname === "/api/events" && req.method === "GET") {
        // SECURITY: cap concurrent SSE connections per-IP + globally
        // (each holds a response + a keepalive timer; unbounded = FD/memory DoS).
        const ip = clientIp(req);
        const ipCount = ip ? [...sseClients].filter((r) => r.weftRemoteIp === ip).length : 0;
        if (sseClients.size >= MAX_SSE_GLOBAL || (ip && ipCount >= MAX_SSE_PER_IP)) {
          res.writeHead(429, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: "too many SSE connections" }));
        }
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        res.write(`event: shop.hello\ndata: {"ok":true}\n\n`);
        res.weftCustomerId = customerId; // per-customer SSE scoping (see broadcast)
        res.weftRemoteIp = ip;
        sseClients.add(res);
        const drop = () => {
          clearInterval(keepalive);
          sseClients.delete(res);
        };
        const keepalive = setInterval(() => {
          if (res.destroyed || res.writableEnded) return drop();
          res.write(":keepalive\n\n");
        }, 15000);
        res.on("close", drop);
        res.on("error", drop);
        return;
      }

      if (url.pathname === "/api/state" && req.method === "GET") {
        return writeJSON(res, 200, state.snapshot(customerId));
      }
      if (url.pathname === "/api/reset" && req.method === "POST") {
        if (!loggedInUser) return writeJSON(res, 401, { error: "login required" });
        state.reset(actor);
        return writeJSON(res, 200, { ok: true });
      }

      if (url.pathname === "/api/products" && req.method === "GET") {
        return writeJSON(res, 200, { products: state.listProducts() });
      }
      const productMatch = url.pathname.match(/^\/api\/products\/([^/]+)$/);
      if (productMatch && req.method === "GET") {
        return writeJSON(res, 200, { product: state.getProduct(productMatch[1]) });
      }
      if (productMatch && req.method === "PATCH") {
        const body = await readJSON(req);
        return writeJSON(res, 200, { product: state.updateProduct(productMatch[1], body, actor) });
      }

      if (url.pathname === "/api/cart" && req.method === "GET") {
        return writeJSON(res, 200, state.cartView(customerId));
      }
      if (url.pathname === "/api/cart" && req.method === "DELETE") {
        return writeJSON(res, 200, state.clearCart(customerId, actor));
      }
      if (url.pathname === "/api/cart/items" && req.method === "POST") {
        const body = await readJSON(req);
        return writeJSON(res, 201, state.addCartItem(customerId, String(body.product_id ?? ""), Number(body.qty ?? 1), actor));
      }
      const cartItemMatch = url.pathname.match(/^\/api\/cart\/items\/([^/]+)$/);
      if (cartItemMatch && req.method === "PATCH") {
        const body = await readJSON(req);
        return writeJSON(res, 200, state.updateCartItem(customerId, cartItemMatch[1], Number(body.qty), actor));
      }
      if (cartItemMatch && req.method === "DELETE") {
        return writeJSON(res, 200, state.removeCartItem(customerId, cartItemMatch[1], actor));
      }

      if (url.pathname === "/api/orders" && req.method === "POST") {
        return writeJSON(res, 201, { order: state.createOrder(customerId, actor) });
      }
      if (url.pathname === "/api/orders" && req.method === "GET") {
        const status = url.searchParams.get("status") ?? undefined;
        return writeJSON(res, 200, { orders: state.listOrders({ customerId, status }) });
      }
      const orderMatch = url.pathname.match(/^\/api\/orders\/([^/]+)$/);
      if (orderMatch && req.method === "GET") {
        return writeJSON(res, 200, { order: state.getOrder(orderMatch[1]) });
      }
      const actionMatch = url.pathname.match(/^\/api\/orders\/([^/]+)\/(pay|cancel|ship|deliver|confirm)$/);
      if (actionMatch && req.method === "POST") {
        return writeJSON(res, 200, { order: state.transitionOrder(actionMatch[1], actionMatch[2], actor) });
      }
      const refundMatch = url.pathname.match(/^\/api\/orders\/([^/]+)\/refund\/(request|approve|deny)$/);
      if (refundMatch && req.method === "POST") {
        const action = { request: "request_refund", approve: "approve_refund", deny: "deny_refund" }[refundMatch[2]];
        return writeJSON(res, 200, { order: state.transitionOrder(refundMatch[1], action, actor) });
      }

      if (url.pathname.startsWith("/api/")) {
        return writeJSON(res, 404, { error: `no route: ${req.method} ${url.pathname}` });
      }
      return serveStatic(res, url.pathname);
    } catch (error) {
      const status = error.status ?? 500;
      return writeJSON(res, status, { error: error.message, ...(error.extra ?? {}) });
    }
  });

  // --- Agentic wiring (integrate-weft-kit runbook Step 1) ---
  // run.mjs's assertWeftdCreds() guarantees the creds before this runs. We do NOT
  // import run.mjs here (avoids its top-level build+listen side effects).
  let ensureApp = async () => { throw new Error("weftd not configured (WEFTD_BASE missing)"); };
  const weftdBase = process.env.WEFTD_BASE?.replace(/\/$/, "");
  if (weftdBase) {
    const apiKey = process.env.WEFT_API_KEY;
    const tenantId = process.env.WEFT_TENANT_ID;
    const systemPrompt = buildShopSystemPrompt("");
    const ctx = createProvisioning({ weftdBase, apiKey, tenantId, shopPort: process.env.SHOP_PORT, systemPrompt });
    ensureApp = ctx.ensureApp;
    // wireSessionRoutes WRAPS the server's request listener — CORS/OPTIONS +
    // X-Weft-Actor + /api/chat/* + /v1/* (verbatim /v1 proxy), falling through to
    // the REST+static handler above. Shared sseClients/sessions.
    wireSessionRoutes(server, { weftdBase, apiKey, tenantId, ensureApp, weftdAPI: ctx.weftdAPI, state, sseClients, sessions });
  }

  return { server, ensureApp };
}

async function readJSON(req) {
  const chunks = [];
  let len = 0;
  for await (const chunk of req) {
    len += chunk.length;
    if (len > MAX_JSON_BODY) { // cap JSON body size
      throw Object.assign(new Error("request body too large"), { status: 413 });
    }
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf-8");
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw Object.assign(new Error("invalid JSON body"), { status: 400 });
  }
}

function writeJSON(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function serveStatic(res, pathname) {
  if (!existsSync(webDist)) {
    return writeJSON(res, 200, {
      service: "online-store-agentic",
      note: "frontend build not found; run `pnpm run build:web` or use the vite dev server (`pnpm dev`)",
    });
  }
  const safePath = normalize(pathname).replace(/^([.][.][/\\])+/, "");
  let filePath = join(webDist, safePath === "/" ? "index.html" : safePath);
  if (!existsSync(filePath)) filePath = join(webDist, "index.html");
  const data = await readFile(filePath);
  const isHtml = extname(filePath) === ".html";
  res.writeHead(200, {
    "Content-Type": contentTypes[extname(filePath)] ?? "application/octet-stream",
    "Cache-Control": isHtml
      ? "no-cache, no-store, must-revalidate"
      : "public, max-age=31536000, immutable",
  });
  res.end(data);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const port = Number(process.env.SHOP_PORT ?? 19745);
  const { server, ensureApp } = createShopServer();
  server.listen(port, "127.0.0.1", () => {
    console.log(JSON.stringify({ ok: true, service: "online-store-agentic", url: `http://127.0.0.1:${port}` }));
    ensureApp().then(() => console.log("[agentic] background provisioning complete")).catch((err) => console.error(`[agentic] background provisioning failed: ${err.message}`));
  });
}
