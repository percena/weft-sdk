"""FastAPI app — the ITSM agentic (classic + Weft).

The classic's REST + SPA, plus the weft layer wired by the integrate-weft-kit
skill (Python branch): the chat-session backend + ``/v1`` reverse proxy
(``session_routes``), the weftd provisioning (``provision``), + the
``X-Weft-Actor`` → event-actor override (``weft`` middleware + ``store.emit``
override). The classic's REST routes + state machine are unchanged — the weft
layer is added on top, not mixed in.
"""
from __future__ import annotations

import os
import threading
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse

from .auth import SESSION_COOKIE, sessions
from .config import settings
from .errors import HttpError
from .provision import create_provisioning
from .routers import (
    auth as auth_router,
    changes as changes_router,
    cis as cis_router,
    events as events_router,
    incidents as incidents_router,
    slas as slas_router,
    state as state_router,
    users as users_router,
)
from .session_routes import create_session_router
from .store import store
from .system_prompt import build_itsm_system_prompt
from .weft import actor_middleware

WEB_DIST = Path(__file__).resolve().parent.parent / "dist"

# --- weftd provisioning (creds from env; run.py asserts them fail-fast) ---
# create_provisioning only stores the creds — no validation, no network. The
# openapi dump (which imports this module without .env) works; ensure_app
# (lifespan/session) is what needs live creds.
provisioning = create_provisioning(
    weftd_base=os.environ.get("WEFTD_BASE", ""),
    api_key=os.environ.get("WEFT_API_KEY", ""),
    tenant_id=os.environ.get("WEFT_TENANT_ID", ""),
    system_prompt=build_itsm_system_prompt(),
    toolset="itsm",
    app_slug="itsm-agentic",
    app_name="ITSM",
    skill_slug="itsmbot",
    graph_slug="itsmgraph",
    model="deepseek-v4-flash",
    spec_path="openapi.json",
)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    store.reset()
    # Background warm-up so the first chat request isn't blocked by the
    # provisioning chain (a dozen weftd calls). ensure_app is thread-safe.
    threading.Thread(target=provisioning.ensure_app, daemon=True).start()
    yield


app = FastAPI(
    title="ITSM Agentic",
    version="0.1.0",
    lifespan=lifespan,
    # FastAPI's auto-openapi emits NO `servers` field by default → flitro
    # rejects the toolset ("no base URL in spec or config"). The store's classic
    # had a hand-added `servers` in openapi.json; for a FastAPI backend, set it
    # in the constructor. The URL is cosmetic for execution:client (the toolset
    # base_url is "" → relative paths, the page origin); it just needs to exist.
    servers=[{"url": "http://127.0.0.1:19755"}],
)

# Actor middleware (X-Weft-Actor:agent → contextvar → store.emit tags "agent")
# runs inside the CORS middleware (CORS is added last → outermost).
app.middleware("http")(actor_middleware)
_cors_origins = [o.strip() for o in settings.cors_origins.split(",") if o.strip()]
if _cors_origins:
    # explicit allowlist → credentialed cross-origin for the configured origins
    app.add_middleware(
        CORSMiddleware,
        allow_origins=_cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
else:
    # dev-only permissive (the Vite dev proxy makes it same-origin): `*` WITHOUT
    # credentials — safe for non-credentialed reads, inert for credentialed, so
    # the same-origin session cookie is never exposed cross-origin.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )


@app.exception_handler(HttpError)
async def http_error_handler(_: Request, exc: HttpError):
    return JSONResponse(status_code=exc.status, content={"error": exc.message, **exc.extra})


# Business routers (in the OpenAPI schema → the agent's itsm_* tools)
for r in (incidents_router, changes_router, cis_router, slas_router, users_router):
    app.include_router(r.router)
# Utility routers (NOT agent tools — excluded from the schema)
for r in (auth_router, events_router, state_router):
    app.include_router(r.router, include_in_schema=False)
# The weft layer: chat-session backend + /v1 proxy (NOT agent tools).
# sessions (cookie sid → username) + session_cookie are INJECTED into
# create_session_router (mirrors the Node port — self-contained, testable by
# test_session_routes_security.py). Pass the app's auth-session map + cookie.
app.include_router(
    create_session_router(provisioning, toolset="itsm", app_name="ITSM",
                          sessions=sessions, session_cookie=SESSION_COOKIE),
    include_in_schema=False,
)


# --- SPA static serve (MUST come after /api + /v1 routes) ---
if WEB_DIST.exists():
    @app.get("/{full_path:path}", include_in_schema=False)
    def spa(full_path: str):
        if full_path.startswith("api/") or full_path.startswith("v1/"):
            return JSONResponse(status_code=404, content={"error": f"no route: /{full_path}"})
        # Starlette does NOT normalize percent-encoded `../`, so `full_path` can
        # arrive as `../../etc/passwd`. Resolve the candidate and confirm it is
        # still under the web root before serving — otherwise any file the
        # process can read (including this app's .env with WEFT_API_KEY) would
        # be exfiltrable.
        web_root = WEB_DIST.resolve()
        candidate = (web_root / full_path).resolve()
        if candidate.is_relative_to(web_root) and candidate.is_file():
            return FileResponse(candidate)
        return FileResponse(web_root / "index.html")
else:
    @app.get("/", include_in_schema=False)
    def _root():
        return JSONResponse({
            "service": "itsm-agentic",
            "note": "frontend build not found; run `pnpm build:web` or use the vite dev server (`pnpm dev`)",
        })
