"""Entrypoint: assert weftd creds (fail-fast), then serve. Skill template
(Python branch) — port of run.mjs but WITHOUT the vite build (the frontend
build is a separate ``pnpm build:web``; ``pnpm start`` chains both).
``ensure_app`` warm-up runs in the lifespan (``app/main.py``), not here.

Placeholder: ``19755`` (the serve port). The env var name (``PORT``) is
generic — rename to ``<APP>_PORT`` if your ``config.py`` uses a prefixed env.
"""
from __future__ import annotations

import os
import sys

from dotenv import load_dotenv

load_dotenv()


def assert_weftd_creds() -> None:
    missing = []
    if not os.environ.get("WEFTD_BASE"):
        missing.append("WEFTD_BASE")
    if not os.environ.get("WEFT_API_KEY"):
        missing.append("WEFT_API_KEY")
    if not os.environ.get("WEFT_TENANT_ID"):
        missing.append("WEFT_TENANT_ID")
    if missing:
        for m in missing:
            print(f"[run] {m} is required in .env", file=sys.stderr)
        print("  (WEFTD_BASE=https://weftd...; WEFT_API_KEY=wsk_...; "
              "WEFT_TENANT_ID=... — see .env.example)", file=sys.stderr)
        sys.exit(1)


assert_weftd_creds()

import uvicorn  # noqa: E402 (after the cred check, so a missing .env fails fast)

port = int(os.environ.get("ITSM_PORT", 19755))
uvicorn.run("app.main:app", host="127.0.0.1", port=port, log_level="info")
