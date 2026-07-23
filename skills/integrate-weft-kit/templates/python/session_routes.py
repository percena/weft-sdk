"""Weftd chat-session backend + ``/v1`` reverse proxy — Python port of the
skill's ``session-routes.mjs``.

FastAPI APIRouter (NOT a listener-wrap — a router-based backend wires via
``app.include_router``; no ``server.listeners`` surgery, no per-route CORS —
the app-level CORSMiddleware covers it; the "6 wiring constraints" from the
Node port dissolve).

The ``/v1/*`` reverse proxy streams the chat traffic (incl. the run/timeline
SSE) to weftd unbuffered, with ONE pre-handshake retry on connection errors
(a transient reverse-proxy TLS-handshake drop — the Node ``http``/``https``
TLS-retry becomes ``httpx.ConnectError``/``ConnectTimeout``; mid-stream errors
surface rather than retry, since the response headers are already sent).

The session-cookie name and SSE event name are app-specific — pass
``session_cookie`` into ``create_session_router`` and use your event name in
the host SSE handler + ``ActionReplayLayer``.
"""
from __future__ import annotations

import json
import os
import posixpath
import time
from urllib.parse import quote

import httpx
from fastapi import APIRouter, Request, Response
from fastapi.responses import JSONResponse, StreamingResponse
from starlette.concurrency import run_in_threadpool

# `sessions` (cookie sid → username) + `session_cookie` (the cookie name) are
# INJECTED into create_session_router (mirrors the Node port's `opts.sessions`),
# so this module is self-contained — no relative `from .auth import` — and
# test_session_routes_security.py can exercise it with a mock sessions map.

# Response headers stripped from the weftd upstream reply (StreamingResponse
# sets its own transfer-encoding/content-length; `host` is never sent on a
# response). Used for the OUTBOUND (weftd → client) direction only.
_HOP_BY_HOP = {
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailers", "transfer-encoding", "upgrade", "content-length",
    "content-encoding", "host",
}

# Request-header allowlist for the /v1/* → weftd reverse proxy (the INBOUND
# direction). Forward only what weftd needs (the scoped Authorization + X-Weft-*
# routing/actor headers); the browser's Cookie + hop-by-hop headers are NEVER
# forwarded to the agent control plane — mirrors the Node port's proxyHeaders().
# A denylist here would leak the same-origin session cookie to weftd on every
# /v1 call (the session cookie is not hop-by-hop); the allowlist makes that impossible
# by construction.
_PROXY_HEADER_ALLOW = {
    "authorization", "accept", "content-type", "content-length", "content-encoding",
    "x-customer-id", "x-weft-actor", "x-weft-session", "x-weft-end-user",
    "x-weft-app", "x-weft-external-account", "x-weft-external-user",
}

# ════════════════════════════════════════════════════════════════════════
# SECURITY (see references/security-contract.md — Tier 1, enforced + tested).
# The helpers below are module-level + importable so
# test_session_routes_security.py can unit-test them; create_session_router
# wires them into the routes. Do NOT weaken (fail-open ownership, non-streaming
# body read, denylist proxy headers, body-supplied end_user_id) — the guard
# catches a regression.
# ════════════════════════════════════════════════════════════════════════

# Body-size caps (security-contract §4). Content-Length is spoofable, so
# the readers stream per-chunk and abort on overflow (Starlette's request.json()
# / request.body() buffer the ENTIRE body with no limit; uvicorn has none either).
MAX_PROXY_BODY = 10 * 1024 * 1024  # 10 MiB for proxied chat traffic
MAX_JSON_BODY = 1 * 1024 * 1024  # 1 MiB for JSON API bodies


async def read_json_capped(request: Request, limit: int):
    """Read the body with a streaming byte cap. Returns None on overflow (caller
    returns 413), {} on empty/parse-error, else the parsed dict.

    Uses a bytearray (mutable) so per-chunk extend is O(1); a bytes `buf += chunk`
    would copy the whole buffer each iteration → O(n²) under chunked 1-byte
    chunks (CPU DoS before the cap rejects). Mirrors read_body_capped's list+join.
    """
    total = 0
    buf = bytearray()
    async for chunk in request.stream():
        total += len(chunk)
        if total > limit:
            return None
        buf.extend(chunk)
    if not buf:
        return {}
    try:
        return json.loads(buf)
    except Exception:
        return {}


async def read_body_capped(request: Request, limit: int):
    """Stream the body with a byte cap. Returns None on overflow (caller 413)."""
    total = 0
    chunks: list[bytes] = []
    async for chunk in request.stream():
        total += len(chunk)
        if total > limit:
            return None
        chunks.append(chunk)
    return b"".join(chunks)


def end_user_id(request: Request, sessions: dict, session_cookie: str) -> str:
    """Derive end_user_id from the authenticated session cookie ONLY (security-
    contract §3). A caller with no valid cookie → 'guest' (the routes 401
    on 'guest' per §1). `sessions` + `session_cookie` are injected (self-
    contained, testable)."""
    sid = request.cookies.get(session_cookie)
    if sid and sid in sessions:
        return sessions[sid]
    return "guest"


def is_session_owner(owners: dict, sid: str, eu: str) -> bool:
    """Fail-CLOSED session-ownership predicate (security-contract §2).
    Returns True ONLY when the caller (eu) is the recorded owner. An unknown
    session (owner is None — post-restart, the in-memory dict lost; or created
    via another path) is REJECTED (False), NOT allowed. The previous
    `owner is not None and owner != eu` failed OPEN on restart — the IDOR
    returned for any known session id. Do not weaken."""
    owner = owners.get(sid)
    return owner is not None and owner == eu


def create_session_router(provisioning, *, toolset: str, app_name: str,
                          sessions: dict, session_cookie: str = "{{sessionCookie}}") -> APIRouter:
    router = APIRouter(tags=["weft"])
    weftd_base = provisioning.weftd_base.rstrip("/")  # no trailing slash
    _u = httpx.URL(weftd_base)
    weftd_path_prefix = _u.path.rstrip("/")  # preserve e.g. "/weftd" sub-path
    weftd_host = _u.host
    # Prefer APP_PUBLIC_BASE; accept PUBLIC_BASE as an alias.
    app_public_base = (
        os.environ.get("APP_PUBLIC_BASE") or os.environ.get("PUBLIC_BASE") or ""
    ).rstrip("/")

    # SECURITY (security-contract §2): session_id → end_user_id
    # ownership map, populated on session create + checked (FAIL CLOSED, via
    # is_session_owner) on token refresh. In-memory only (lost on restart) — the
    # fail-closed default rejects (403) unknown sessions post-restart; a persisted
    # store (SQLite/Redis) is a UX upgrade so re-creation after restart isn't
    # needed, NOT a security fix.
    session_owners: dict[str, str] = {}

    # (MAX_PROXY_BODY / MAX_JSON_BODY + read_json_capped / read_body_capped /
    # end_user_id / is_session_owner are the module-level exports above.)

    def public_base_url(request: Request) -> str:
        if app_public_base:
            return app_public_base
        proto = (request.headers.get("x-forwarded-proto", "").split(",")[0].strip()
                 or "http")
        host = request.headers.get("x-forwarded-host") or request.headers.get("host")
        return f"{proto}://{host}" if host else ""

    # (end_user_id is the module-level export above — end_user_id(request,
    # sessions, session_cookie).)

    # --- chat session bootstrap (this server holds the weftd dev credential) ---
    @router.post("/api/chat/session")
    async def create_session(request: Request):
        body = await read_json_capped(request, MAX_JSON_BODY)
        if body is None:
            return JSONResponse({"error": "request body too large"}, status_code=413)
        body = body or {}
        eu = end_user_id(request, sessions, session_cookie)
        # SECURITY (security-contract §1): reject unauthenticated callers —
        # ship a 401 default so an integrator who copies the template inherits
        # a safe default instead of minting weftd sessions for anyone with no cookie.
        if not eu or eu == "guest":
            return JSONResponse({"error": "authentication required"}, status_code=401)
        try:
            ctx = await run_in_threadpool(provisioning.ensure_app)
            # Host-seal permission_mode=auto (this call uses WEFT_API_KEY, not
            # the browser embed JWT). weftd's fenced-autonomy gate refuses
            # untrusted embed elevate ask→auto, so the panel's Auto selector
            # only works when the host sealed auto at createSession. The
            # per-message selector can still tighten to ask/explore.
            # Demo/e2e default — production should seal ask (or omit → ask) + policy.
            session = await run_in_threadpool(
                provisioning.weftd_api, "POST", "/v1/sessions",
                {
                    "end_user_id": eu,
                    "app_id": ctx["app_id"],
                    "external_user_id": eu,
                    "external_account_id": body.get("external_account_id") or "default-org",
                    "toolset": toolset,
                    "title": f"{app_name} — {eu}",
                    "credential": {"token": f"{toolset}-cred-{eu}-{int(time.time())}", "scheme": "bearer"},
                    "config": {"permission_mode": "auto"},
                },
            )
            if isinstance(session, dict) and session.get("session_id"):
                session_owners[session["session_id"]] = eu
            return JSONResponse({**session, "base_url": public_base_url(request)}, status_code=201)
        except Exception as e:
            return JSONResponse({"error": f"weftd session bootstrap failed: {e}"}, status_code=502)

    # --- token refresh (the browser's onTokenExpired lands here) ---
    @router.post("/api/chat/session/{sid}/token")
    async def refresh_token(sid: str, request: Request):
        eu = end_user_id(request, sessions, session_cookie)
        # SECURITY (security-contract §1): reject unauthenticated callers.
        if not eu or eu == "guest":
            return JSONResponse({"error": "authentication required"}, status_code=401)
        # SECURITY (security-contract §2): FAIL CLOSED — if the session is
        # not in the in-memory map (post-restart / created elsewhere), reject.
        # is_session_owner is the module-level fail-closed predicate — do NOT
        # inline a weaker one.
        if not is_session_owner(session_owners, sid, eu):
            return JSONResponse({"error": "not the session owner"}, status_code=403)
        try:
            await run_in_threadpool(provisioning.ensure_app)
            session = await run_in_threadpool(
                provisioning.weftd_api, "POST", f"/v1/sessions/{quote(sid)}/token",
                {"credential": {"token": f"{toolset}-cred-{eu}-{int(time.time())}", "scheme": "bearer"}},
            )
            return JSONResponse({**session, "base_url": public_base_url(request)})
        except Exception as e:
            return JSONResponse({"error": f"weftd token refresh failed: {e}"}, status_code=502)

    # --- /v1 reverse proxy (streaming, pre-handshake TLS retry) ---
    @router.api_route(
        "/v1/{rest:path}",
        methods=["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"],
    )
    async def proxy_v1(rest: str, request: Request):
        query = str(request.url.query) if request.url.query else ""
        upstream_url = f"{weftd_base}{weftd_path_prefix}/v1/{rest}" + (f"?{query}" if query else "")
        # SECURITY (security-contract §4): reject oversized proxied bodies
        # with a STREAMING read (Content-Length is spoofable, so a pre-check alone
        # is insufficient; Starlette's request.body() buffers the entire body with
        # no limit, and uvicorn has no default body limit).
        body = await read_body_capped(request, MAX_PROXY_BODY)
        if body is None:
            return JSONResponse({"error": "request body too large"}, status_code=413)
        # SECURITY (security-contract §4): normalize the path BEFORE the
        # denylist check — Starlette does not normalize `..` in {rest:path} (so
        # /v1/sessions/../tenants/ yields rest="sessions/../tenants/" and bypasses
        # the denylist), but httpx normalizes `..` when building the upstream URL,
        # sending /v1/tenants/ to weftd with the scoped token. posixpath.normpath
        # closes the bypass.
        admin_paths = ("/v1/tenants", "/v1/admin", "/v1/platform")
        proxied = posixpath.normpath(f"/v1/{rest}")
        if proxied in admin_paths or proxied.startswith(tuple(p + "/" for p in admin_paths)):
            return JSONResponse({"error": "not found"}, status_code=404)
        headers = {k: v for k, v in request.headers.items() if k.lower() in _PROXY_HEADER_ALLOW}
        if weftd_host:
            headers["host"] = weftd_host

        client = httpx.AsyncClient(timeout=httpx.Timeout(None), follow_redirects=False)
        req = client.build_request(
            request.method, upstream_url, headers=headers, content=body if body else None,
        )
        resp = None
        for attempt in range(2):
            try:
                resp = await client.send(req, stream=True)
                break
            except (httpx.ConnectError, httpx.ConnectTimeout) as e:
                if attempt == 0:
                    continue  # one pre-handshake retry (a reverse-proxy TLS-handshake drop)
                await client.aclose()
                return JSONResponse({"error": f"weftd proxy failed: {e}"}, status_code=502)

        async def gen():
            try:
                async for chunk in resp.aiter_raw():
                    yield chunk
            finally:
                await resp.aclose()
                await client.aclose()

        out_headers = {k: v for k, v in resp.headers.items() if k.lower() not in _HOP_BY_HOP}
        return StreamingResponse(
            gen(),
            status_code=resp.status_code,
            headers=out_headers,
            media_type=resp.headers.get("content-type"),
        )

    return router
