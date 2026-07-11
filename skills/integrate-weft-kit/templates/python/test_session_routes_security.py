"""Security-regression guard for session_routes.py.

Asserts the Tier-1 invariants from references/security-contract.md that the
TEMPLATE enforces: §1 auth (401), §2 ownership fail-closed (403), §3
end_user_id from cookie, §4 proxy (header allowlist + path-normalize denylist
[the Python `..` bypass] + streaming body cap). (§5 SSE cap is app-level — in
the host events router, not this template — so it is NOT tested here; §6 CORS
is app-level — the app's CORSMiddleware — also not here. The integrator's
SKILL.md §6 checklist covers both.)

This is the closed loop's executable security dimension (SKILL.md §6): a
future weakening of the template (fail-open ownership, non-streaming body
read, denylist proxy headers, body-supplied end_user_id, no path-normalize)
FAILS this guard at `pytest`. Run it in CI.

It is a TEMPLATE: copy next to session_routes.py + `pytest -q`. The import
works both in a package (``from .session_routes``) and standalone (run from
the dir containing session_routes.py — the skill-verification path).
"""
from __future__ import annotations

import asyncio

from fastapi import FastAPI
from fastapi.testclient import TestClient

try:  # package context (integrator's app) — relative import
    from .session_routes import (
        MAX_JSON_BODY, MAX_PROXY_BODY, _PROXY_HEADER_ALLOW,
        create_session_router, end_user_id,
        is_session_owner, read_body_capped, read_json_capped,
    )
except ImportError:  # standalone (skill verification) — run from this dir
    from session_routes import (  # type: ignore[no-redef]
        MAX_JSON_BODY, MAX_PROXY_BODY, _PROXY_HEADER_ALLOW,
        create_session_router, end_user_id,
        is_session_owner, read_body_capped, read_json_capped,
    )


# ─── mock provisioning (the integrator-backend side is fully testable without weftd)
class MockProvisioning:
    weftd_base = "http://127.0.0.1:9"  # closed port (any forwarded /v1 errors; the denylist + body-cap fire first)

    def ensure_app(self):  # sync — the template awaits run_in_threadpool(ensure_app)
        return {"tenant_id": "tid", "app_id": "aid"}

    def weftd_api(self, method, path, body=None):  # sync
        if method == "POST" and path == "/v1/sessions":
            return {"session_id": "sid-alice-1", "token": "tok", "base_url": "http://x", "expires_at": 0}
        if method == "POST" and path.startswith("/v1/sessions/") and path.endswith("/token"):
            return {"session_id": "sid-alice-1", "token": "tok-refreshed", "base_url": "http://x", "expires_at": 0}
        raise AssertionError(f"mock weftd_api: unexpected {method} {path}")


# Fixture cookie name for the guard — host apps substitute {{sessionCookie}}.
SESSION_COOKIE = "app_session"


def _build_app(sessions: dict, session_cookie: str = SESSION_COOKIE) -> FastAPI:
    app = FastAPI()
    app.include_router(create_session_router(
        MockProvisioning(), toolset="test", app_name="Test",
        sessions=sessions, session_cookie=session_cookie,
    ))
    return app


def _cookie(sessions: dict, user: str, session_cookie: str = SESSION_COOKIE) -> str:
    sid = f"sess-{user}"
    sessions[sid] = user
    return f"{session_cookie}={sid}"


# ════════════════════════════════════════════════════════════════════════
# UNIT — the module-level helpers
# ════════════════════════════════════════════════════════════════════════

class _Req:
    def __init__(self, cookies=None, headers=None):
        self.cookies = cookies or {}
        self.headers = headers or {}


def test_end_user_id_from_cookie_only():
    sessions = {"sess-alice": "alice"}
    assert end_user_id(_Req({SESSION_COOKIE: "sess-alice"}), sessions, SESSION_COOKIE) == "alice"
    assert end_user_id(_Req({}), sessions, SESSION_COOKIE) == "guest"               # no cookie
    assert end_user_id(_Req({SESSION_COOKIE: "unknown"}), sessions, SESSION_COOKIE) == "guest"  # invalid
    assert end_user_id(_Req({"other": "x"}), sessions, SESSION_COOKIE) == "guest"    # wrong name


def test_is_session_owner_fail_closed():
    owners = {"sid-a": "alice"}
    assert is_session_owner(owners, "sid-a", "alice") is True       # owner
    assert is_session_owner(owners, "sid-a", "bob") is False        # non-owner → 403
    assert is_session_owner(owners, "sid-unknown", "alice") is False  # UNKNOWN → 403 (post-restart edge)
    assert is_session_owner({}, "sid-a", "alice") is False          # empty map (post-restart) → 403


def test_read_json_capped_overflow():
    class _Stream:
        def __init__(self, data): self._data = data
        async def stream(self):
            yield self._data
    assert asyncio.run(read_json_capped(_Stream(b"x" * (MAX_JSON_BODY + 1)), MAX_JSON_BODY)) is None  # overflow → None
    assert asyncio.run(read_json_capped(_Stream(b""), MAX_JSON_BODY)) == {}                            # empty → {}


def test_read_body_capped_overflow():
    class _Stream:
        def __init__(self, data): self._data = data
        async def stream(self):
            yield self._data
    assert asyncio.run(read_body_capped(_Stream(b"x" * (MAX_PROXY_BODY + 1)), MAX_PROXY_BODY)) is None
    assert asyncio.run(read_body_capped(_Stream(b"ok"), MAX_PROXY_BODY)) == b"ok"


def test_proxy_header_allowlist_membership():
    # Mirrors the Node guard's proxyHeaders unit test: the /v1 proxy forwards only
    # the allowlisted headers. A future weakening (adding "cookie" to the set, or
    # switching to a denylist) MUST fail this — the same-origin session cookie is
    # NOT hop-by-hop and would leak to weftd on every /v1 call.
    assert "authorization" in _PROXY_HEADER_ALLOW       # scoped token forwarded
    assert "cookie" not in _PROXY_HEADER_ALLOW          # session cookie stripped
    assert "x-evil" not in _PROXY_HEADER_ALLOW          # unknown stripped (allowlist, not denylist)
    assert "x-weft-actor" in _PROXY_HEADER_ALLOW        # X-Weft-* forwarded


# ════════════════════════════════════════════════════════════════════════
# INTEGRATION — create_session_router end-to-end (TestClient + mock provisioning)
# ════════════════════════════════════════════════════════════════════════

def test_unauth_session_create_401():
    sessions = {}
    client = TestClient(_build_app(sessions))
    r = client.post("/api/chat/session", json={})  # no cookie
    assert r.status_code == 401


def test_auth_session_create_201():
    sessions = {}
    client = TestClient(_build_app(sessions))
    r = client.post("/api/chat/session", json={}, headers={"cookie": _cookie(sessions, "alice")})
    assert r.status_code == 201
    assert r.json()["session_id"] == "sid-alice-1"


def test_non_owner_token_403_owner_200():
    sessions = {}
    client = TestClient(_build_app(sessions))
    alice = _cookie(sessions, "alice")
    bob = _cookie(sessions, "bob")
    created = client.post("/api/chat/session", json={}, headers={"cookie": alice})
    sid = created.json()["session_id"]
    assert client.post(f"/api/chat/session/{sid}/token", headers={"cookie": alice}).status_code == 200
    assert client.post(f"/api/chat/session/{sid}/token", headers={"cookie": bob}).status_code == 403
    assert client.post(f"/api/chat/session/{sid}/token").status_code == 401  # unauth refresh


def test_post_restart_token_403_fail_closed():
    # a session created on one app instance; a FRESH app instance (empty
    # session_owners — the post-restart condition) rejects the refresh.
    sessions = {}
    c1 = TestClient(_build_app(sessions))
    created = c1.post("/api/chat/session", json={}, headers={"cookie": _cookie(sessions, "alice")})
    sid = created.json()["session_id"]
    c2 = TestClient(_build_app(sessions))  # fresh router = empty session_owners
    r = c2.post(f"/api/chat/session/{sid}/token", headers={"cookie": _cookie(sessions, "alice")})
    assert r.status_code == 403, "unknown session post-restart MUST be rejected (fail-closed)"


def test_v1_admin_denylist_normalized_404():
    sessions = {}
    client = TestClient(_build_app(sessions))
    assert client.get("/v1/tenants").status_code == 404
    assert client.get("/v1/tenants/").status_code == 404
    # the Python `..` bypass: Starlette doesn't normalize; httpx would. normpath closes it.
    assert client.get("/v1/sessions/../tenants/").status_code == 404
    assert client.get("/v1/admin/x").status_code == 404
    assert client.get("/v1/platform/y").status_code == 404
    # %2f / // variants — Starlette decodes %2f → / before the {rest:path} capture,
    # so posixpath.normpath collapses them to /v1/tenants → 404 (parity with the
    # Node guard's %2f // cases; a regression that drops normpath fails here).
    assert client.get("/v1/%2ftenants").status_code == 404
    assert client.get("/v1//tenants").status_code == 404


def test_oversized_body_413():
    sessions = {}
    client = TestClient(_build_app(sessions))
    # a body larger than MAX_JSON_BODY to /api/chat/session → read_json_capped → 413
    big = "x" * (MAX_JSON_BODY + 1)
    r = client.post("/api/chat/session", content=big, headers={
        "cookie": _cookie(sessions, "alice"), "content-type": "text/plain",
    })
    assert r.status_code == 413
