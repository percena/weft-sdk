"""FastAPI app — the ITSM classic.

Auto-OpenAPI at ``/openapi.json`` (the skill's tool/graph source). Serves the
built SPA from ``dist/`` with an SPA fallback. CORS defaults to permissive
``*`` WITHOUT credentials (the Vite dev proxy makes it same-origin; safe for
non-credentialed reads, inert for credentialed); set ``ITSM_CORS_ORIGINS`` to an
exact-origin allowlist for credentialed cross-origin in prod. The ``HttpError`` handler renders the
``409 { error, allowed_actions }`` backstop the agent's prompt relies on.
"""
from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse

from .config import settings
from .errors import HttpError
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
from .store import store

WEB_DIST = Path(__file__).resolve().parent.parent / "dist"


@asynccontextmanager
async def lifespan(_app: FastAPI):
    store.reset()  # ensure seeded on start
    yield


app = FastAPI(title="ITSM Classic", version="0.1.0", lifespan=lifespan)
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


# Business routers stay in the OpenAPI schema (they ARE the agent's tools —
# the skill derives `itsm_<operationId>` tool names from /openapi.json).
for r in (
    incidents_router,
    changes_router,
    cis_router,
    slas_router,
    users_router,
):
    app.include_router(r.router)

# Utility routers (auth/events/state) are NOT agent tools — exclude them from
# the schema so /openapi.json is already curated (no hand-maintained spec file,
# unlike the store's classic). The skill reads the live /openapi.json directly.
for r in (auth_router, events_router, state_router):
    app.include_router(r.router, include_in_schema=False)


# --- SPA static serve (production). In dev, Vite proxies /api to this app. ---
if WEB_DIST.exists():
    @app.get("/{full_path:path}", include_in_schema=False)
    def spa(full_path: str):
        if full_path.startswith("api/"):
            return JSONResponse(status_code=404, content={"error": f"no route: /{full_path}"})
        candidate = WEB_DIST / full_path
        if candidate.is_file():
            return FileResponse(candidate)
        return FileResponse(WEB_DIST / "index.html")
else:
    @app.get("/", include_in_schema=False)
    def _root():
        return JSONResponse({
            "service": "itsm-classic",
            "note": "frontend build not found; run `pnpm build:web` or use the vite dev server (`pnpm dev`)",
        })
